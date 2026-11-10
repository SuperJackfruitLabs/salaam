// How a desk session's local command is launched: the sandbox it runs under, the argv that puts it
// there, the environment it gets and how its approval describes it. Pure: the caller spawns.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_NETWORK_PORT, type BrokerRelay } from './command-network.js';
import {
  sandboxArgv,
  seatbeltArgv,
  type Bwrap,
  type SandboxKind,
  type SandboxLevel,
  type Seatbelt,
} from './command-sandbox.js';
import { gitIdentityEnv } from './git-helpers.js';
import { toolArgv, type ToolIdentity } from './tool-identity.js';

/** A desk tool call: an edit or a command, bound to its approval's operation. */
export interface LocalCall {
  id: string;
  session_id: string;
  attempt_id: string;
  epoch: number;
  tool_call: string;
  input_digest: string;
  root: string;
  args: string;
  operation_id: string;
  state: string;
  result: string | null;
  pid: number | null;
  identity: string | null;
}
/**
 * Item 10: how this host runs local commands. `bwrap` (Linux) or `seatbelt` (macOS): under the OS
 * sandbox at `level` (full-access only by explicit operator setting). `none`: a host with no usable
 * sandbox, which refuses local commands unless the operator allowed them unsandboxed
 * (`allowUnsandboxed`); then it runs them and says so in every approval.
 */
export interface LocalSandbox {
  kind: SandboxKind;
  level: SandboxLevel;
  bwrap: Bwrap | null;
  seatbelt?: Seatbelt | null;
  /** The host config's `unsandboxed_commands: "allow"` (operator ruling 2026-10-30, option A). */
  allowUnsandboxed?: boolean;
  /** The host config's `command_network: "broker"`: a sandboxed command reaches the network only
   * through this stk local-commands socket (operator rulings 2026-10-30). */
  network?: { socket: string };
  /** Operator-allowed read-only paths outside the workspace (Phase 1, 2026-10-31). */
  readPaths?: string[];
}

/** Holds the shell before any user instruction until its identity is durably owned. */
export const START_GATE = 'IFS= read -r salaam_start_gate || exit 125\nexec 0</dev/null\n';
/** The only PATH a command or hook gets: never the daemon's own environment. */
export const COMMAND_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** The proxy a broker-network command uses: only the relay on loopback, nothing direct. */
function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
}

export function isSandboxed(sb: LocalSandbox): boolean {
  return sb.kind !== 'none' && sb.level !== 'full-access';
}

/** Broker network applies only to a sandboxed command: unsandboxed ones are not confined anyway. */
export function brokerNetwork(sb: LocalSandbox): { socket: string } | null {
  return sb.network && isSandboxed(sb) ? sb.network : null;
}

/** Seatbelt has no tmpfs: each sandboxed command gets its own private tmp, removed when it ends. */
export function privateTmp(sb: LocalSandbox, prefix: string): string | undefined {
  return sb.kind === 'seatbelt' && sb.level !== 'full-access'
    ? realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    : undefined;
}

/**
 * Git settings a sandboxed command gets, because the sandbox keeps the repository's config
 * read-only: a new branch from a remote-tracking branch does not try (and fail) to record its
 * upstream, and a plain `git push` pushes the current branch to the same name. Passed as
 * GIT_CONFIG_COUNT entries, which name no program and are read only by the command's own git;
 * a command that sets GIT_CONFIG_COUNT itself replaces them.
 */
export const SANDBOX_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['branch.autoSetupMerge', 'false'],
  ['push.default', 'current'],
];
/** `env` with these config entries added after any GIT_CONFIG_COUNT entries it already has. */
export function appendGitConfig(
  env: Record<string, string>,
  entries: readonly (readonly [string, string])[],
): Record<string, string> {
  const given = Number(env.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isSafeInteger(given) && given > 0 ? given : 0;
  const out = { ...env };
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(start + entries.length);
  return out;
}

/** A command's environment. Deliberately not the daemon's: no provider credentials or tokens. */
export function commandEnv(
  root: string,
  sb: LocalSandbox,
  relay: BrokerRelay | null,
): Record<string, string> {
  const env = {
    PATH: COMMAND_PATH,
    HOME: process.env.HOME ?? root,
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    ...(isSandboxed(sb) ? gitIdentityEnv(root) : {}),
    ...(relay ? proxyEnv(relay.port ?? COMMAND_NETWORK_PORT) : {}),
  };
  return isSandboxed(sb) ? appendGitConfig(env, SANDBOX_GIT_CONFIG) : env;
}

/** The process a command runs as. Under the tools user, the host-side shell reports its own
 * process group (the one a stop kills) before exec-ing bubblewrap, whose PID namespace would
 * otherwise report a number that means nothing on the host. */
export function commandArgv(
  tools: ToolIdentity,
  root: string,
  script: string,
  tmp: string | undefined,
  relay: BrokerRelay | null | undefined,
  sb: LocalSandbox,
  listen: boolean,
): string[] {
  const sandboxed = isSandboxed(sb);
  const inner = (s: string) =>
    !sandboxed
      ? ['/bin/sh', '-c', s]
      : sb.kind === 'seatbelt'
        ? seatbeltArgv(sb.level, root, tmp ?? '', ['/bin/sh', '-c', s], sb.seatbelt ?? null, {
            network: false,
            ...(relay?.port ? { brokerPort: relay.port } : {}),
            readPaths: sb.readPaths ?? [],
            ...(listen ? { listen: true } : {}),
          })
        : sandboxArgv(sb.level, root, ['/bin/sh', '-c', s], sb.bwrap, {
            network: false,
            ...(relay?.dir ? { broker: { dir: relay.dir, node: process.execPath } } : {}),
            readPaths: sb.readPaths ?? [],
          });
  if (tools.mode !== 'tools-user') return inner(script);
  const marker = 'umask 0002\nprintf \'salaam-tool-pgid:%s\\n\' "$$"\n';
  return sandboxed
    ? toolArgv(tools, [
        '/usr/bin/setsid',
        '-w',
        '/bin/sh',
        '-c',
        marker + 'exec "$@"',
        'sh',
        ...inner(script),
      ])
    : toolArgv(tools, ['/usr/bin/setsid', '-w', '/bin/sh', '-c', marker + script]);
}

/** A read-only helper Salaam runs itself (no shell, no approval) under the host's sandbox at the
 * read-only level, whatever level commands get: whatever it starts is confined like a sandboxed
 * command. The caller checks isSandboxed first. */
export function readOnlySandboxArgv(
  sb: LocalSandbox,
  root: string,
  argv: string[],
  tmp: string | undefined,
): string[] {
  const options = { network: false, readPaths: sb.readPaths ?? [] };
  return sb.kind === 'seatbelt'
    ? seatbeltArgv('read-only', root, tmp ?? '', argv, sb.seatbelt ?? null, options)
    : sandboxArgv('read-only', root, argv, sb.bwrap, options);
}

/** How an approval describes where a command runs. `host` is the host's own sandbox, `sb` the one
 * this command was approved under. */
export function sandboxText(host: LocalSandbox, sb: LocalSandbox, outside: boolean): string {
  const { kind, level } = sb;
  if (outside)
    return 'unsandboxed for this one command, at its own request: it can read and change any file your user can and reach the network.';
  if (level === 'full-access')
    return host.level === 'full-access'
      ? 'unsandboxed: the operator chose full access. May access files and network beyond this workspace.'
      : 'unsandboxed: you turned on full access for this session. May access files and network beyond this workspace.';
  if (kind === 'none')
    return 'unsandboxed: this host has no usable command sandbox, so the command may access files and network beyond this workspace.';
  const name = kind === 'seatbelt' ? 'Seatbelt' : 'bubblewrap';
  const net = brokerNetwork(sb)
    ? 'network: through the broker allowlist (hosts set by the stk policy), nothing direct.'
    : 'has no network.';
  const reads = host.readPaths?.length
    ? ` It can also read ${host.readPaths.length} operator-allowed path${host.readPaths.length === 1 ? '' : 's'} outside the workspace.`
    : '';
  return level === 'read-only'
    ? `in a ${name} sandbox (read-only): it can read this workspace but write nothing, and ${net}${reads}`
    : `in a ${name} sandbox (workspace-write): it can write only inside this workspace, and ${net}${reads}`;
}

/** Where a session's next command runs, in a word or two for the status and side panels. */
export function commandSandboxLabel(host: LocalSandbox, access: string | undefined): string {
  if (access) return access === 'yolo' ? 'YOLO' : 'full access';
  if (host.level === 'full-access') return 'no sandbox';
  if (host.kind === 'none') return host.allowUnsandboxed ? 'no sandbox' : 'refused';
  return host.kind === 'seatbelt' ? 'Seatbelt' : 'bubblewrap';
}

/** The isolation a command's result records. */
export function isolation(tools: ToolIdentity, sb: LocalSandbox): string {
  return (
    (tools.mode === 'tools-user' ? 'tools-user-' : 'local-user-') +
    (isSandboxed(sb) ? sb.kind + '-' + sb.level : 'no-os-sandbox')
  );
}
