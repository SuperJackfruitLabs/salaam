import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { digest, ServiceError } from '../core/index.js';
import type { McpServerProvenance } from '../core/index.js';

/**
 * Operator-declared MCP servers: the operator's own grant, read only from Salaam's
 * configuration directory. Workspaces never declare servers; Pi keeps --no-mcp and every
 * declared server is reached through the daemon over the worker bridge.
 */
export interface StdioDeclaration {
  name: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface HttpDeclaration {
  name: string;
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}
export type McpDeclaration = StdioDeclaration | HttpDeclaration;
export interface OperatorMcpFile {
  version: 1;
  servers: McpDeclaration[];
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;
// Literal text around references may only be a short scheme word such as "Bearer ".
const LITERAL = /^(?:[A-Za-z][A-Za-z-]{0,15} ?)?$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function operatorMcpPath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(env.HOME || homedir(), '.config');
  return join(base, 'salaam', 'mcp.json');
}

function fail(message: string): never {
  throw new ServiceError('invalid_mcp_config', message, 400);
}
function keys(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}"`);
}
function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

/** A value must be built from ${VAR} references; inline secrets are refused. */
export function assertReference(value: unknown, where: string): string[] {
  if (typeof value !== 'string' || value.length > 1024) fail(`${where} must be a string`);
  const names = [...value.matchAll(REF)].map((m) => m[1]!);
  const literal = value.replace(REF, '');
  if (!names.length || !LITERAL.test(literal))
    fail(`${where} must reference an environment variable as \${VAR}; inline secrets are refused`);
  return names;
}
function referenceMap(value: unknown, where: string, key: RegExp): Record<string, string> {
  const map = record(value, where);
  for (const [k, v] of Object.entries(map)) {
    if (!key.test(k)) fail(`${where}: invalid name "${k}"`);
    assertReference(v, `${where}.${k}`);
  }
  return map as Record<string, string>;
}

/** Shape validation shared by the CLI and the service. Does not touch PATH or env. */
export function validateDeclaration(input: unknown, index = 0): McpDeclaration {
  const where = `servers[${index}]`;
  const s = record(input, where);
  if (typeof s.name !== 'string' || !NAME.test(s.name))
    fail(`${where}.name must match ${NAME.source}`);
  const at = `server "${s.name}"`;
  if (s.transport === 'stdio') {
    keys(s, ['name', 'transport', 'command', 'args', 'cwd', 'env'], at);
    if (typeof s.command !== 'string' || !s.command || s.command.length > 4096)
      fail(`${at}: command is required`);
    if (!isAbsolute(s.command) && s.command.includes('/'))
      fail(`${at}: command must be absolute or a bare name on PATH`);
    if (
      s.args !== undefined &&
      (!Array.isArray(s.args) ||
        s.args.length > 256 ||
        s.args.some((a) => typeof a !== 'string' || a.length > 4096))
    )
      fail(`${at}: args must be a list of strings`);
    if (s.cwd !== undefined && (typeof s.cwd !== 'string' || !isAbsolute(s.cwd)))
      fail(`${at}: cwd must be absolute`);
    if (s.env !== undefined) referenceMap(s.env, `${at}: env`, ENV_KEY);
    return {
      name: s.name,
      transport: 'stdio',
      command: s.command,
      ...(s.args ? { args: [...(s.args as string[])] } : {}),
      ...(s.cwd ? { cwd: s.cwd as string } : {}),
      ...(s.env ? { env: { ...(s.env as Record<string, string>) } } : {}),
    };
  }
  if (s.transport === 'http') {
    keys(s, ['name', 'transport', 'url', 'headers'], at);
    if (typeof s.url !== 'string' || !URL.canParse(s.url)) fail(`${at}: url is invalid`);
    const url = new URL(s.url);
    if (url.username || url.password) fail(`${at}: url must not carry credentials`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
      fail(`${at}: url must be https (http only on loopback)`);
    if (s.headers !== undefined) referenceMap(s.headers, `${at}: headers`, HEADER);
    return {
      name: s.name,
      transport: 'http',
      url: s.url,
      ...(s.headers ? { headers: { ...(s.headers as Record<string, string>) } } : {}),
    };
  }
  fail(`${at}: transport must be "stdio" or "http"`);
}

export function validateOperatorMcp(input: unknown): OperatorMcpFile {
  const file = record(input, 'mcp.json');
  keys(file, ['version', 'servers'], 'mcp.json');
  if (file.version !== 1) fail('mcp.json: version must be 1');
  if (!Array.isArray(file.servers) || file.servers.length > 64)
    fail('mcp.json: servers must be a list of at most 64');
  const servers = file.servers.map((s, i) => validateDeclaration(s, i));
  const seen = new Set<string>();
  for (const s of servers) {
    if (seen.has(s.name)) fail(`mcp.json: duplicate server name "${s.name}"`);
    seen.add(s.name);
  }
  return { version: 1, servers };
}

export function readOperatorMcpFile(path: string): OperatorMcpFile {
  if (!existsSync(path)) return { version: 1, servers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${path} is not valid JSON`);
  }
  return validateOperatorMcp(parsed);
}
export function writeOperatorMcpFile(path: string, file: OperatorMcpFile): void {
  const valid = validateOperatorMcp(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

export const declarationDigest = (d: McpDeclaration): string => digest(d);

export function resolveCommand(command: string, env: NodeJS.ProcessEnv): string {
  const executable = (path: string) => {
    try {
      return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };
  if (isAbsolute(command)) {
    if (!executable(command)) fail(`command ${command} is not an executable file`);
    return command;
  }
  for (const dir of (env.PATH ?? '').split(delimiter))
    if (dir && isAbsolute(dir) && executable(join(dir, command))) return join(dir, command);
  fail(`command "${command}" is not on PATH`);
}
function resolveReferences(
  map: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
  where: string,
): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [
      k,
      v.replace(REF, (_m, name: string) => {
        const value = env[name];
        if (value === undefined) fail(`${where}.${k} references unset variable ${name}`);
        return value;
      }),
    ]),
  );
}

interface Resolved {
  declaration: McpDeclaration;
  provenance: McpServerProvenance;
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
interface Connection {
  client: Client;
  transport: Transport;
  ready: Promise<void>;
}
const CALL_TIMEOUT_MS = 120_000;
const RESULT_LIMIT = 262_144;

export class OperatorMcp {
  readonly servers: Resolved[];
  readonly digest: string;
  private readonly sessions = new Map<string, Map<string, Connection>>();
  private readonly secrets: string[];

  /** Resolves commands and references now, so a bad declaration refuses service start. */
  constructor(
    readonly file: OperatorMcpFile,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const valid = validateOperatorMcp(file);
    this.servers = valid.servers.map((declaration) => {
      const declaration_digest = declarationDigest(declaration);
      if (declaration.transport === 'stdio') {
        const command = resolveCommand(declaration.command, env);
        return {
          declaration,
          command,
          env: resolveReferences(declaration.env, env, `server "${declaration.name}": env`),
          provenance: {
            name: declaration.name,
            source: 'operator',
            transport: 'stdio',
            command,
            args: declaration.args ?? [],
            declaration_digest,
          },
        };
      }
      return {
        declaration,
        headers: resolveReferences(
          declaration.headers,
          env,
          `server "${declaration.name}": headers`,
        ),
        provenance: {
          name: declaration.name,
          source: 'operator',
          transport: 'http',
          url: declaration.url,
          declaration_digest,
        },
      };
    });
    this.digest = digest(valid);
    this.secrets = this.servers
      .flatMap((s) => [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})])
      .filter((v) => v.length >= 8);
  }
  static load(path: string, env: NodeJS.ProcessEnv = process.env): OperatorMcp {
    return new OperatorMcp(readOperatorMcpFile(path), env);
  }
  provenance(): McpServerProvenance[] {
    return this.servers.map((s) => structuredClone(s.provenance));
  }
  get empty(): boolean {
    return this.servers.length === 0;
  }
  private server(name: unknown): Resolved {
    const server = this.servers.find((s) => s.declaration.name === name);
    if (!server) throw new ServiceError('invalid_mcp_server', 'Unknown declared MCP server', 400);
    return server;
  }
  private connection(session: string, server: Resolved): Connection {
    let owned = this.sessions.get(session);
    if (!owned) this.sessions.set(session, (owned = new Map()));
    const existing = owned.get(server.declaration.name);
    if (existing) return existing;
    const client = new Client({ name: 'salaam', version: '1' }, { capabilities: {} });
    const d = server.declaration;
    const transport: Transport =
      d.transport === 'stdio'
        ? new StdioClientTransport({
            command: server.command!,
            args: d.args ?? [],
            ...(d.cwd ? { cwd: d.cwd } : {}),
            ...(server.env ? { env: server.env } : {}),
            stderr: 'ignore',
          })
        : new StreamableHTTPClientTransport(new URL(d.url), {
            requestInit: { headers: server.headers ?? {}, redirect: 'error' },
          });
    const connection: Connection = {
      client,
      transport,
      ready: client.connect(transport, { timeout: 30_000 }),
    };
    connection.ready.catch(() => owned!.delete(d.name));
    owned.set(d.name, connection);
    return connection;
  }
  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    return out;
  }
  private failure(error: unknown): never {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'mcp_server_failed',
      this.redact(`Declared MCP server failed: ${(error as Error)?.message ?? 'unknown'}`).slice(
        0,
        512,
      ),
      502,
    );
  }
  async catalog(session: string, serverName?: unknown, tool?: unknown): Promise<unknown> {
    if (serverName === undefined || serverName === null || serverName === '')
      return { servers: this.provenance().map(({ name, transport }) => ({ name, transport })) };
    const server = this.server(serverName);
    try {
      const c = this.connection(session, server);
      await c.ready;
      const { tools } = await c.client.listTools(undefined, { timeout: 30_000 });
      if (tool === undefined || tool === null || tool === '')
        return {
          server: server.declaration.name,
          tools: tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
        };
      const found = tools.find((t) => t.name === tool);
      if (!found) throw new ServiceError('invalid_mcp_tool', 'Unknown tool on that server', 400);
      return { server: server.declaration.name, tool: found };
    } catch (error) {
      this.failure(error);
    }
  }
  async call(
    session: string,
    serverName: unknown,
    tool: unknown,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: { type: 'text'; text: string }[]; is_error: boolean }> {
    const server = this.server(serverName);
    if (typeof tool !== 'string' || !tool || tool.length > 128)
      throw new ServiceError('invalid_mcp_tool', 'A tool name is required', 400);
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))
      throw new ServiceError('invalid_mcp_arguments', 'Arguments must be an object', 400);
    try {
      const c = this.connection(session, server);
      await c.ready;
      const result = await c.client.callTool(
        { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      const parts = Array.isArray(result.content) ? result.content : [];
      let budget = RESULT_LIMIT;
      const content = parts.map((part) => {
        const text = this.redact(
          part.type === 'text' ? String(part.text) : JSON.stringify(part),
        ).slice(0, Math.max(0, budget));
        budget -= text.length;
        return { type: 'text' as const, text };
      });
      if (result.structuredContent && !content.length)
        content.push({
          type: 'text',
          text: this.redact(JSON.stringify(result.structuredContent)).slice(0, RESULT_LIMIT),
        });
      return { content, is_error: !!result.isError };
    } catch (error) {
      this.failure(error);
    }
  }
  async stopSession(session: string): Promise<void> {
    const owned = this.sessions.get(session);
    this.sessions.delete(session);
    if (!owned) return;
    await Promise.allSettled([...owned.values()].map((c) => c.client.close()));
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((s) => this.stopSession(s)));
  }
}

/** Both sources may serve one session; a shared name is refused rather than shadowed. */
export function mergeMcpProvenance(
  operator: readonly McpServerProvenance[],
  agentpod: readonly McpServerProvenance[],
): McpServerProvenance[] {
  const names = new Set(agentpod.map((s) => s.name));
  const clash = operator.find((s) => names.has(s.name));
  if (clash)
    throw new ServiceError(
      'mcp_name_collision',
      `Declared MCP server "${clash.name}" collides with an AgentPod-assigned server`,
      409,
    );
  return [...operator, ...agentpod];
}
