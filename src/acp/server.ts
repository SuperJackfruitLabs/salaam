import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  call,
  acpFailure,
  AcpFailureError,
  object,
  string,
  ServiceError,
  type ControlLease,
} from '../core/index.js';
import { AcpJournal } from './journal.js';
import { ensureDeskService } from './desk.js';
import {
  controller,
  releaseLease,
  send,
  type AcpContext,
  type BoundAdmission,
  type Json,
} from './context.js';
import { cancel } from './receipts.js';
import { setMode } from './desk-session.js';
import { refresh } from './refresh.js';
import { initialize, openSession } from './sessions.js';
import { prompt } from './prompt.js';

/** Largest unanswered input the transport buffers. */
const INPUT_LIMIT = 1024 * 1024;
/** Requests one transport may have in flight. */
const ACTIVE_REQUEST_LIMIT = 32;
/** How often unconfirmed cancellations are re-read, and controller leases renewed. */
const CANCELLATION_POLL_MS = 250;
const LEASE_RENEW_MS = 5000;

/** ACP v1 newline-delimited stdio adapter. The daemon remains the only worker owner. The
 * methods live beside it: sessions (initialize, new, load, resume), prompt, desk-session (modes,
 * /rewind), approvals, refresh (the session's feed) and receipts. */
export async function acp(
  state: string,
  options: { coding?: boolean; local?: boolean } = {},
): Promise<void> {
  const socket = join(state, 'operator.sock');
  if (options.local) await ensureDeskService(state);
  const client = acpClientState(state);
  const journal = new AcpJournal(client);
  const admission = process.env.SALAAM_AGENTPOD_ADMISSION,
    admissionToken = process.env.SALAAM_AGENTPOD_TOKEN;
  delete process.env.SALAAM_AGENTPOD_ADMISSION;
  delete process.env.SALAAM_AGENTPOD_TOKEN;
  if (!!admission !== !!admissionToken)
    throw Error('AgentPod admission requires both credential fields');
  const bound = admission
    ? await call<BoundAdmission>(socket, '/v1/agentpod/attach', {
        admission_id: admission,
        token: admissionToken,
      })
    : undefined;
  const strictWork = bound?.work_control !== undefined;
  if (
    strictWork &&
    (JSON.stringify(bound?.work_control) !==
      JSON.stringify({ version: 1, owner: 'superpipeline' }) ||
      bound?.binding.run.source !== 'superpipeline')
  )
    throw new Error('Unsupported authenticated work control handoff');
  const ctx: AcpContext = {
    socket,
    client,
    journal,
    options,
    admission,
    admissionToken,
    bound,
    strictWork,
    closed: false,
    ignoredMcp: false,
    initialized: false,
    wantsReceipts: false,
    wantsCancellations: false,
    wantsTypedStops: false,
    sessions: new Map(),
    permissionReplies: new Map(),
    confirmations: new Map(),
    activeRequests: new Set(),
    output: Promise.resolve(),
  };
  const cancellationPoll = setInterval(() => {
    for (const c of ctx.sessions.values())
      if ([...c.cancellations.values()].some((value) => JSON.parse(value).state !== 'confirmed'))
        void refresh(ctx, c).catch((error) => {
          c.failed = error;
        });
  }, CANCELLATION_POLL_MS);
  cancellationPoll.unref();
  const renew = setInterval(() => {
    for (const c of ctx.sessions.values())
      if (c.lease && !strictWork) {
        void call<ControlLease>(socket, `/v1/sessions/${c.id}/control`, {
          request_id: randomUUID(),
          client_id: c.client,
          token: c.lease.token,
          action: 'renew',
          expected_epoch: c.lease.epoch,
        })
          .then((lease) => {
            c.lease = lease;
          })
          .catch((error) => {
            c.failed = error;
            delete c.lease;
          });
      }
  }, LEASE_RENEW_MS);
  try {
    await readInput(ctx);
  } finally {
    ctx.closed = true;
    clearInterval(renew);
    clearInterval(cancellationPoll);
    ctx.permissionReplies.clear();
    for (const resolve of ctx.confirmations.values()) resolve('cancelled');
    ctx.confirmations.clear();
    for (const c of ctx.sessions.values()) {
      c.feed?.close();
      if (c.lease) await releaseLease(ctx, c, c.lease).catch(() => {});
    }
  }
}

/** One ACP method call. */
async function invoke(ctx: AcpContext, method: string, params: Json): Promise<unknown> {
  if (method === 'initialize') return initialize(ctx, params);
  if (!ctx.initialized) throw new Error('Initialize ACP v1 first');
  if (method === '_salaam/inbox/list')
    return call(ctx.socket, '/v1/inbox?offset=' + encodeURIComponent(String(params.offset ?? 0)));
  if (method === '_salaam/inbox/ack') {
    const id = string(params.id, 'id', 128),
      item = await call<{ session_id: string }>(ctx.socket, `/v1/inbox/${id}`),
      c = ctx.sessions.get(item.session_id);
    if (!c) throw new Error('Connect the attention session before acknowledgement');
    return call(ctx.socket, `/v1/inbox/${id}/ack`, {
      ...(await controller(ctx, c)),
      request_id: string(params.request_id, 'request_id', 128),
      expected_revision: params.expected_revision,
    });
  }
  if (['session/new', 'session/load', 'session/resume'].includes(method))
    return openSession(ctx, method, params);
  if (method === 'session/set_mode' || method === 'session/set_config_option') {
    const c = ctx.sessions.get(string(params.sessionId, 'sessionId', 128));
    if (!c) throw new Error('Load or resume this session first');
    if (method === 'session/set_mode') {
      await setMode(ctx, c, string(params.modeId, 'modeId', 64));
      return {};
    }
    if (params.configId !== 'mode') throw new Error('Unknown setting');
    const state = await setMode(ctx, c, string(params.value, 'value', 64));
    return { configOptions: 'configOptions' in state ? state.configOptions : [] };
  }
  if (!['session/cancel', 'session/prompt'].includes(method))
    throw new ServiceError('method_not_found', 'Unsupported ACP method', 404);
  const c = ctx.sessions.get(string(params.sessionId, 'sessionId', 128));
  if (!c) throw new Error('Load or resume this session first');
  if (method === 'session/cancel') {
    const meta = object(params._meta ?? {});
    await cancel(
      ctx,
      c,
      meta['salaam.dev/cancellationId'] === undefined
        ? randomUUID()
        : string(meta['salaam.dev/cancellationId'], 'cancellationId', 128),
      meta['salaam.dev/targetRequestId'] === undefined
        ? (c.activePrompts.keys().next().value ?? null)
        : string(meta['salaam.dev/targetRequestId'], 'targetRequestId', 128),
    );
    return {};
  }
  if (method !== 'session/prompt')
    throw new ServiceError('method_not_found', 'Unsupported ACP method', 404);
  return prompt(ctx, c, params);
}

/** The JSON-RPC error an exception becomes. */
function errorCode(error: unknown): number {
  return error instanceof ServiceError && error.code === 'method_not_found'
    ? -32601
    : error instanceof AcpFailureError
      ? -32000
      : error instanceof ServiceError && !['invalid_field', 'invalid_json'].includes(error.code)
        ? -32000
        : -32602;
}

/** A response from the editor to a question this transport asked. */
async function reply(ctx: AcpContext, id: unknown, value: Json): Promise<void> {
  const resolve = typeof id === 'string' ? ctx.confirmations.get(id) : undefined;
  if (typeof id === 'string' && resolve) {
    ctx.confirmations.delete(id);
    const outcome = object(object(value.result ?? {}).outcome ?? {});
    resolve(
      !value.error && outcome.outcome === 'selected' ? String(outcome.optionId) : 'cancelled',
    );
    return;
  }
  const respond = typeof id === 'string' ? ctx.permissionReplies.get(id) : undefined;
  if (typeof id === 'string' && respond) {
    ctx.permissionReplies.delete(id);
    if (value.error) return; // Leave durable approval pending on client failure.
    await respond(object(value.result));
  }
}

async function handle(ctx: AcpContext, line: string): Promise<void> {
  let id: unknown = null;
  let response = false;
  try {
    let value: Json;
    try {
      value = object(JSON.parse(line));
    } catch {
      await send(ctx, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    if (value.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version');
    id = value.id;
    if (typeof value.method !== 'string') {
      response = true;
      await reply(ctx, id, value);
      return;
    }
    if (id !== undefined && typeof id !== 'string' && typeof id !== 'number')
      throw new Error('Invalid request ID');
    const key = JSON.stringify(id);
    if (id !== undefined) {
      if (ctx.activeRequests.has(key) || ctx.activeRequests.size >= ACTIVE_REQUEST_LIMIT)
        throw new Error('Request already active or transport busy');
      ctx.activeRequests.add(key);
    }
    try {
      const result = await invoke(ctx, value.method, object(value.params ?? {}));
      if (id !== undefined) await send(ctx, { jsonrpc: '2.0', id, result });
    } finally {
      if (id !== undefined) ctx.activeRequests.delete(key);
    }
  } catch (error) {
    if (id !== undefined && !response)
      await send(ctx, {
        jsonrpc: '2.0',
        id,
        error: {
          code: errorCode(error),
          message: acpFailure(error).message,
          data: { 'salaam.dev/failure': acpFailure(error) },
        },
      });
    else console.error('ACP notification rejected:', (error as Error).message);
  }
}

/** Read newline-delimited requests from stdin until it ends or the process is told to stop. */
function readInput(ctx: AcpContext): Promise<void> {
  let buffer = '';
  return new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > INPUT_LIMIT) {
        console.error('ACP input exceeds 1 MiB');
        process.stdin.destroy();
        resolve();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) void handle(ctx, line);
      }
    });
    process.stdin.once('end', resolve);
    process.stdin.once('error', resolve);
    process.stdout.once('error', resolve);
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
}

/** A launcher-profile daemon's state belongs to root; its ACP clients keep their own
 * journal and outbox in the caller's state home, keyed by the daemon state path. */
export function acpClientState(state: string, env: NodeJS.ProcessEnv = process.env): string {
  let own = false;
  try {
    own = statSync(state).uid === process.getuid?.();
  } catch {
    // A state path this user cannot stat is not its own.
  }
  if (own) return state;
  const home = env.XDG_STATE_HOME || join(env.HOME ?? '/nonexistent', '.local/state');
  const dir = join(
    home,
    'salaam/acp-clients',
    createHash('sha256').update(state).digest('hex').slice(0, 32),
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
