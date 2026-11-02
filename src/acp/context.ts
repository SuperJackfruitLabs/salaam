// One ACP transport's state and the primitives every method uses: writing a message, a session
// update, the service calls for a snapshot and permissions, the controller lease, and asking the
// editor one question.
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  call,
  object,
  ServiceError,
  type AgentPodBinding,
  type ControlLease,
  type SessionSnapshot,
} from '../core/index.js';
import type { McpWorkerBinding } from '../mcp/index.js';
import { acquireControl, type Feed } from '../tui/index.js';
import type { DeskPermissions } from './desk.js';
import type { AcpJournal } from './journal.js';
import type { PermissionMode } from '../local/index.js';

export type Json = Record<string, unknown>;

/** One session connected on this transport. */
export interface Connection {
  id: string;
  lease?: ControlLease;
  controlPending?: Promise<ControlLease>;
  client: string;
  seen: Set<string>;
  promptStates: Map<string, string>;
  cancellations: Map<string, string>;
  activePrompts: Map<string, number>;
  liveTools: Set<string>;
  operations: Map<string, string>;
  permissions: Set<string>;
  cursor: number;
  inboxDigest?: string;
  feed?: Feed;
  refresh?: Promise<void>;
  dirty: boolean;
  decisions: Promise<void>;
  failed?: Error;
  /** The last plan sent, so an unchanged task sends nothing. */
  plan?: string;
  /** Your own local coding session: modes, rules, diffs and /rewind apply. */
  desk?: { rules: boolean; mode?: string; policyMode?: PermissionMode };
}

/** The AgentPod admission this transport was started with. */
export interface BoundAdmission {
  session_id: string;
  binding: AgentPodBinding;
  managed_mcp?: McpWorkerBinding | null;
  work_control?: { version: 1; owner: 'superpipeline' };
}

/** Everything one transport shares across its sessions and requests. */
export interface AcpContext {
  readonly socket: string;
  /** Where this client keeps its journal and outbox. */
  readonly client: string;
  readonly journal: AcpJournal;
  readonly options: { coding?: boolean; local?: boolean };
  readonly admission: string | undefined;
  readonly admissionToken: string | undefined;
  readonly bound: BoundAdmission | undefined;
  /** Authenticated work owns control: this transport never holds a lease past bootstrap. */
  readonly strictWork: boolean;
  closed: boolean;
  ignoredMcp: boolean;
  initialized: boolean;
  wantsReceipts: boolean;
  wantsCancellations: boolean;
  wantsTypedStops: boolean;
  readonly sessions: Map<string, Connection>;
  readonly permissionReplies: Map<string, (result: Json) => Promise<void>>;
  /** Questions asked through the editor's permission prompt; an error or cancel counts as no. */
  readonly confirmations: Map<string, (option: string) => void>;
  readonly activeRequests: Set<string>;
  /** Writes are serialized: each waits for the one before it to drain. */
  output: Promise<void>;
}

export function send(ctx: AcpContext, value: unknown): Promise<void> {
  ctx.output = ctx.output.then(async () => {
    if (ctx.closed) return;
    if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain');
  });
  return ctx.output;
}

export function update(ctx: AcpContext, id: string, value: Json): Promise<void> {
  const stable = typeof value.messageId === 'string' || value.toolCallId !== undefined;
  const out = stable
    ? {
        ...value,
        _meta: {
          ...object(value._meta ?? {}),
          'salaam.dev/updateId': createHash('sha256')
            .update(JSON.stringify({ id, value }))
            .digest('hex'),
        },
      }
    : value;
  return send(ctx, {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: out },
  });
}

export function text(
  ctx: AcpContext,
  id: string,
  role: string,
  content: string,
  message: string,
  part = 0,
): Promise<void> {
  return update(ctx, id, {
    sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
    messageId: message,
    _meta: { 'salaam.dev/sourcePart': part },
    content: { type: 'text', text: content },
  });
}

export function say(ctx: AcpContext, id: string, message: string): Promise<void> {
  return update(ctx, id, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: message },
  });
}

export function snapshot(ctx: AcpContext, id: string): Promise<SessionSnapshot> {
  return call<SessionSnapshot>(ctx.socket, `/v1/sessions/${id}/snapshot`);
}

export function permissions(
  ctx: AcpContext,
  id: string,
): Promise<DeskPermissions & { coding: boolean; configurable: boolean }> {
  return call<DeskPermissions & { coding: boolean; configurable: boolean }>(
    ctx.socket,
    `/v1/sessions/${id}/permissions`,
  );
}

/** The controller credentials for a session, acquiring its lease on first use. */
export async function controller(
  ctx: AcpContext,
  c: Connection,
  takeover = false,
  bootstrap = false,
): Promise<{ client_id: string; token: string }> {
  if (ctx.strictWork && (!bootstrap || takeover))
    throw new ServiceError(
      'work_control_owned',
      'The authenticated work owner controls this session',
    );
  if (!c.lease) {
    c.controlPending ??= acquireControl(ctx.socket, c.id, c.client, takeover)
      .then((lease) => {
        c.lease = lease;
        return lease;
      })
      .finally(() => {
        delete c.controlPending;
      });
    await c.controlPending;
  }
  if (!c.lease)
    throw new ServiceError('control_required', 'A current controller lease is required');
  return { client_id: c.client, token: c.lease.token };
}

/** Release this transport's own lease on a session, if it holds one. */
export function releaseLease(
  ctx: AcpContext,
  c: Connection,
  lease: ControlLease,
): Promise<unknown> {
  return call(ctx.socket, `/v1/sessions/${c.id}/control`, {
    request_id: randomUUID(),
    action: 'release',
    client_id: c.client,
    token: lease.token,
    expected_epoch: lease.epoch,
  });
}

/** Ask one question in the editor and wait for the chosen option id. */
export async function ask(
  ctx: AcpContext,
  c: Connection,
  title: string,
  body: string,
  options: { optionId: string; name: string; kind: string }[],
): Promise<string> {
  const id = 'confirm:' + randomUUID();
  const toolCall = {
    toolCallId: 'salaam-' + id,
    title,
    kind: 'other',
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: body } }],
  };
  await update(ctx, c.id, { sessionUpdate: 'tool_call', ...toolCall });
  const chosen = new Promise<string>((resolve) => ctx.confirmations.set(id, resolve));
  await send(ctx, {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: { sessionId: c.id, toolCall, options },
  });
  const option = await chosen;
  await update(ctx, c.id, {
    sessionUpdate: 'tool_call_update',
    toolCallId: toolCall.toolCallId,
    status: option === 'cancel' || option === 'cancelled' ? 'failed' : 'completed',
  });
  return option;
}
