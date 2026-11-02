// What a desk session's local command asks for: its arguments checked and bound to the sandbox it
// will run under, and the review text its approval shows.
import { ServiceError, string } from '../core/index.js';
import { UNSANDBOXED_REFUSAL } from './command-sandbox.js';
import { brokerNetwork, isSandboxed, type LocalSandbox } from './command-launch.js';
import type { DangerVerdict } from './command-danger.js';
import type { LocalEdit } from './edits.js';
import type { ToolIdentity } from './tool-identity.js';
import { BACKGROUND_LIFETIME, TASK_TAIL } from './background-tasks.js';

/** A foreground command's timeout when it names none, and the bounds one may name. */
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
/** The longest command text, and the longest reason for running outside the sandbox. */
const COMMAND_LIMIT = 8192;
const OUTSIDE_REASON_LIMIT = 300;

export type CommandArgs = {
  action: 'command';
  command: string;
  timeout_ms: number;
  background?: true;
  listen?: true;
  /** Why this one command asked to run without the OS sandbox. */
  outside_sandbox?: string;
  sandbox: { kind: string; level: string; bwrap: string | null; network?: 'broker' };
};
export type LocalArgs = { action: 'edit'; edits: LocalEdit[] } | CommandArgs;

/** What checking a command needs from its session, asked in this order. */
export interface CommandContext {
  assertBackground(): void;
  /** The sandbox the session's next command would run under. */
  sandboxFor(): LocalSandbox;
  allowOutsideSandbox: boolean;
  toolsUser: boolean;
}

export function commandArgs(input: Record<string, unknown>, ctx: CommandContext): CommandArgs {
  const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeout) ||
    Number(timeout) < MIN_TIMEOUT_MS ||
    Number(timeout) > MAX_TIMEOUT_MS
  )
    throw new ServiceError('invalid_field', 'Command timeout must be 100–120000 ms');
  const background = input.background === true;
  if (input.background !== undefined && typeof input.background !== 'boolean')
    throw new ServiceError('invalid_field', 'background must be true or false');
  if (background) ctx.assertBackground();
  if (input.listen !== undefined && typeof input.listen !== 'boolean')
    throw new ServiceError('invalid_field', 'listen must be true or false');
  if (
    input.outside_sandbox !== undefined &&
    (typeof input.outside_sandbox !== 'string' || !input.outside_sandbox.trim())
  )
    throw new ServiceError(
      'invalid_field',
      'outside_sandbox must say why the command needs to run without the sandbox',
    );
  const session_sb = ctx.sandboxFor();
  // Only a sandboxed session has anything to step out of; under full access it changes nothing.
  const outside =
    typeof input.outside_sandbox === 'string' && isSandboxed(session_sb)
      ? input.outside_sandbox.trim().slice(0, OUTSIDE_REASON_LIMIT)
      : undefined;
  if (outside !== undefined && (!ctx.allowOutsideSandbox || ctx.toolsUser))
    throw new ServiceError(
      'outside_sandbox_denied',
      'The operator does not allow commands outside the OS sandbox on this host. Ask the person to run it themselves.',
    );
  const sb: LocalSandbox =
    outside !== undefined ? { ...session_sb, level: 'full-access' } : session_sb;
  // Operator ruling 2026-11-01 (option C): a sandboxed command listens only when a person
  // approves that exact command to. Linux's sandbox has its own network, so it cannot serve.
  const listen = input.listen === true && isSandboxed(sb);
  if (listen && sb.kind === 'bwrap')
    throw new ServiceError(
      'listen_unreachable',
      'On Linux the command sandbox has its own network namespace, so a server it starts cannot be reached from the host. Ask for full access for this command, or run the server yourself.',
    );
  if (sb.kind === 'bwrap' && sb.level !== 'full-access' && !sb.bwrap)
    throw new ServiceError(
      'sandbox_unavailable',
      'This host has no usable bubblewrap, so it cannot run a sandboxed command; an operator can choose full access explicitly',
    );
  if (sb.kind === 'none' && sb.level !== 'full-access' && !sb.allowUnsandboxed)
    throw new ServiceError('sandbox_unavailable', UNSANDBOXED_REFUSAL);
  return {
    action: 'command',
    command: string(input.command, 'command', COMMAND_LIMIT),
    timeout_ms: background ? BACKGROUND_LIFETIME : Number(timeout),
    ...(background ? { background: true as const } : {}),
    ...(listen ? { listen: true as const } : {}),
    ...(outside !== undefined ? { outside_sandbox: outside } : {}),
    // Bound into the approval and the operation digest: the sandbox is part of what is approved.
    sandbox: {
      kind: sb.kind,
      level: sb.level,
      bwrap: sb.bwrap?.version ?? null,
      ...(brokerNetwork(sb) ? { network: 'broker' as const } : {}),
    },
  };
}

/** The approval text for a local command; `where` says what sandbox it runs in. */
export function commandReview(
  tools: ToolIdentity,
  where: string,
  root: string,
  args: CommandArgs,
  danger: DangerVerdict,
  publishes: string | null,
): string {
  return `Runs as ${tools.mode === 'tools-user' ? `tools user ${tools.user} (uid ${tools.uid})` : 'your local user'}, ${where}\nDirectory: ${root}${args.background ? `\nRuns in the background until stopped (at most ${BACKGROUND_LIFETIME / 3600000} h); the last ${TASK_TAIL / 1024} KiB of output is kept` : `\nTimeout: ${args.timeout_ms} ms`}\n${danger.dangerous ? `Dangerous (${danger.category}): ${danger.reason}\n` : ''}${publishes ? `Publishes: ${publishes}; this always asks, except in YOLO\n` : ''}${args.outside_sandbox ? `Outside the sandbox: ${args.outside_sandbox}. This one command runs without the OS sandbox; the session stays sandboxed. This always asks, except in YOLO or your own rule\n` : ''}${args.listen ? 'May listen: this command may accept network connections. macOS cannot limit listening to localhost, so a server bound to 0.0.0.0 is reachable from your network. This always asks, except in YOLO or your own rule\n' : ''}Command:\n${args.command}`;
}
