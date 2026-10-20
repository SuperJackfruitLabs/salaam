import { agentpodBinding, type AgentPodBinding } from './agentpod-protocol.js';
import { canonical, integer, object, ServiceError, string } from './protocol.js';

export interface McpToolPin {
  name: string;
  schema_digest: string;
  policy: 'read' | 'approval';
}
export interface McpServerPin {
  name: 'agentpod' | 'superlibrary';
  protocol_version: '2025-06-18' | '2025-11-25';
  catalog_digest: string;
  tools: McpToolPin[];
}
export interface McpProfile {
  version: 1;
  scope: 'agentpod-proxy';
  proxy_origin: string;
  servers: McpServerPin[];
  limits: {
    request_bytes: number;
    response_bytes: number;
    timeout_ms: number;
    calls_per_attempt: number;
  };
}
/** Private node control data; never a Hub/ACP/provider-facing document. */
export interface McpAssignment {
  version: 1;
  binding: AgentPodBinding;
  profile_digest: string;
  credential_generation: number;
  servers: {
    type: 'http';
    name: 'agentpod' | 'superlibrary';
    url: string;
    headers: { name: 'X-Agentpod-Proxy-Key'; value: string }[];
  }[];
}
/** Shared final egress guard, including adapters that do not use the HTTP client. */
export function redactMcpData(value: unknown, secrets: readonly string[]): unknown {
  const patterns = secrets.flatMap((secret) => [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
  ]);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      for (const pattern of patterns) value = (value as string).replaceAll(pattern, '[redacted]');
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [String(walk(key)), walk(v)]),
      );
    return value;
  };
  return walk(value);
}
function invalid(): never {
  throw new ServiceError('invalid_mcp_config', 'Unsupported managed MCP configuration', 400);
}
function sha(value: unknown): string {
  const s = string(value, 'MCP digest', 64);
  if (!/^[a-f0-9]{64}$/.test(s)) invalid();
  return s;
}
function bound(value: unknown, min: number, max: number): number {
  const n = integer(value, 'MCP limit');
  if (n < min || n > max) invalid();
  return n;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) invalid();
  return value;
}
function named<T extends { name: string }>(values: T[]): T[] {
  if (new Set(values.map((v) => v.name)).size !== values.length) invalid();
  return values;
}
function server(value: unknown): McpServerPin['name'] {
  if (value !== 'agentpod' && value !== 'superlibrary') invalid();
  return value;
}
export function mcpProxyOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(u.hostname) &&
      !!u.port &&
      !u.username &&
      !u.password &&
      u.origin === value
    );
  } catch {
    return false;
  }
}
function exact<T>(value: T, original: unknown): T {
  if (canonical(value) !== canonical(original)) invalid();
  return value;
}
function toolPins(value: unknown): McpToolPin[] {
  return named(
    array(value, 128).map((value): McpToolPin => {
      const t = object(value),
        name = string(t.name, 'MCP tool name', 128);
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || (t.policy !== 'read' && t.policy !== 'approval'))
        invalid();
      return exact({ name, schema_digest: sha(t.schema_digest), policy: t.policy }, t);
    }),
  );
}
export interface McpAdmissionView {
  version: 1;
  profile_digest: string;
  assignment_digest: string;
  binding_digest: string;
  credential_generation: number;
  servers: {
    name: McpServerPin['name'];
    endpoint_digest: string;
    catalog_digest: string;
    tools: McpToolPin[];
  }[];
}
export function mcpAdmissionView(input: unknown): McpAdmissionView {
  try {
    const p = object(input);
    if (p.version !== 1) invalid();
    return exact(
      {
        version: 1 as const,
        profile_digest: sha(p.profile_digest),
        assignment_digest: sha(p.assignment_digest),
        binding_digest: sha(p.binding_digest),
        credential_generation: bound(p.credential_generation, 1, Number.MAX_SAFE_INTEGER),
        servers: named(
          array(p.servers, 2).map((value) => {
            const s = object(value);
            return exact(
              {
                name: server(s.name),
                endpoint_digest: sha(s.endpoint_digest),
                catalog_digest: sha(s.catalog_digest),
                tools: toolPins(s.tools),
              },
              s,
            );
          }),
        ),
      },
      p,
    );
  } catch {
    return invalid();
  }
}
export function mcpProfile(input: unknown): McpProfile {
  try {
    const p = object(input),
      limits = object(p.limits);
    if (p.version !== 1 || p.scope !== 'agentpod-proxy') invalid();
    const origin = string(p.proxy_origin, 'MCP origin', 128);
    if (!mcpProxyOrigin(origin)) invalid();
    return exact<McpProfile>(
      {
        version: 1,
        scope: 'agentpod-proxy',
        proxy_origin: origin,
        servers: named(
          array(p.servers, 2).map((value): McpServerPin => {
            const s = object(value);
            if (s.protocol_version !== '2025-06-18' && s.protocol_version !== '2025-11-25')
              invalid();
            return exact(
              {
                name: server(s.name),
                protocol_version: s.protocol_version,
                catalog_digest: sha(s.catalog_digest),
                tools: toolPins(s.tools),
              },
              s,
            );
          }),
        ),
        limits: exact(
          {
            request_bytes: bound(limits.request_bytes, 1024, 65536),
            response_bytes: bound(limits.response_bytes, 1024, 1048576),
            timeout_ms: bound(limits.timeout_ms, 100, 30000),
            calls_per_attempt: bound(limits.calls_per_attempt, 1, 32),
          },
          limits,
        ),
      },
      p,
    );
  } catch {
    return invalid();
  }
}
export function mcpAssignment(input: unknown): McpAssignment {
  try {
    const a = object(input);
    if (a.version !== 1) invalid();
    const binding = agentpodBinding(a.binding),
      origins = new Set<string>(),
      keys = new Set<string>();
    const result: McpAssignment = {
      version: 1,
      binding,
      profile_digest: sha(a.profile_digest),
      credential_generation: bound(a.credential_generation, 1, Number.MAX_SAFE_INTEGER),
      servers: named(
        array(a.servers, 2).map((value): McpAssignment['servers'][number] => {
          const s = object(value),
            name = server(s.name),
            url = string(s.url, 'MCP endpoint', 1024),
            u = new URL(url),
            parts = u.pathname.split('/');
          if (
            s.type !== 'http' ||
            !mcpProxyOrigin(u.origin) ||
            u.username ||
            u.password ||
            u.search ||
            u.hash ||
            u.href !== url ||
            url !== u.origin + u.pathname ||
            parts.length !== 6 ||
            parts[1] !== 'stations' ||
            decodeURIComponent(parts[2]!) !== binding.station_id ||
            parts[3] !== 'mcp-managed-v1' ||
            !/^[a-f0-9]{64}$/.test(parts[4]!) ||
            parts[5] !== (name === 'agentpod' ? 'hub' : 'superlibrary')
          )
            invalid();
          const headers = array(s.headers, 1).map(
            (value): { name: 'X-Agentpod-Proxy-Key'; value: string } => {
              const h = object(value),
                v = string(h.value, 'private proxy credential', 128);
              if (h.name !== 'X-Agentpod-Proxy-Key' || !/^[A-Za-z0-9_-]{32,128}$/.test(v))
                invalid();
              return exact({ name: 'X-Agentpod-Proxy-Key', value: v }, h);
            },
          );
          origins.add(u.origin);
          keys.add(headers[0]!.value);
          return exact({ type: 'http', name, url, headers }, s);
        }),
      ),
    };
    if (origins.size !== 1 || keys.size !== 1) invalid();
    return exact(result, a);
  } catch {
    return invalid();
  }
}
