import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import { call } from './transport.js';
import { acquireControl, Outbox, subscribe, type Feed } from './attach.js';
import { AcpJournal } from './acp-journal.js';
import {
  object,
  string,
  ServiceError,
  type SessionSnapshot,
  type ControlLease,
  type Approval,
  type Operation,
  type Attempt,
} from './protocol.js';

type Json = Record<string, unknown>;
interface Connection {
  id: string;
  lease?: ControlLease;
  client: string;
  seen: Set<string>;
  liveTools: Set<string>;
  operations: Map<string, string>;
  permissions: Set<string>;
  cursor: number;
  feed?: Feed;
  refresh?: Promise<void>;
  dirty: boolean;
  decisions: Promise<void>;
  failed?: Error;
}
/** ACP v1 newline-delimited stdio adapter. The daemon remains the only worker owner. */
export async function acp(state: string, options: { coding?: boolean } = {}): Promise<void> {
  const socket = join(state, 'operator.sock');
  const journal = new AcpJournal(state);
  let closed = false,
    initialized = false;
  const sessions = new Map<string, Connection>();
  const permissionReplies = new Map<string, (result: Json) => Promise<void>>();
  const activeRequests = new Set<string>();
  let output = Promise.resolve();
  const send = (value: unknown): Promise<void> => {
    output = output.then(async () => {
      if (closed) return;
      if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain');
    });
    return output;
  };
  const update = (id: string, value: unknown) =>
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: value } });
  const text = (id: string, role: string, content: string, message: string) =>
    update(id, {
      sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      messageId: message,
      content: { type: 'text', text: content },
    });
  const snapshot = (id: string) => call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
  const readEntry = async (id: string, entry: string): Promise<Json> => {
    let content = '',
      offset: number | null = 0;
    while (offset !== null) {
      const page: { text: string; next_offset: number | null } = await call(
        socket,
        `/v1/sessions/${id}/history?entry_id=${encodeURIComponent(entry)}&offset=${offset}`,
      );
      content += page.text;
      offset = page.next_offset;
      if (content.length > 4 * 1024 * 1024)
        throw new Error('Pi history entry exceeds protocol limit');
    }
    return object(JSON.parse(content));
  };
  const replay = async (c: Connection, emit: boolean, includeUsers = false) => {
    let offset: number | null = 0;
    while (offset !== null && !closed) {
      const page: { entries: { entry_id: string }[]; next_offset: number | null } = await call(
        socket,
        `/v1/sessions/${c.id}/history?branch=true&offset=${offset}`,
      );
      for (const item of page.entries) {
        if (c.seen.has(item.entry_id)) continue;
        const entry = await readEntry(c.id, item.entry_id);
        if (emit && entry.message) {
          const message = object(entry.message);
          const parts =
            typeof message.content === 'string'
              ? [{ type: 'text', text: message.content }]
              : Array.isArray(message.content)
                ? message.content.map(object)
                : [];
          if (message.role === 'user' || message.role === 'assistant') {
            for (const part of parts) {
              // The editor already displays its submitted prompt. User chunks belong
              // to explicit history loading, otherwise Zed renders a second copy.
              if (
                part.type === 'text' &&
                typeof part.text === 'string' &&
                (message.role !== 'user' || includeUsers)
              )
                await text(c.id, String(message.role), part.text, item.entry_id);
              if (part.type === 'toolCall' && !c.liveTools.has(String(part.id))) {
                c.liveTools.add(String(part.id));
                await update(c.id, {
                  sessionUpdate: 'tool_call',
                  toolCallId: String(part.id),
                  title: String(part.name),
                  kind: 'other',
                  status: 'in_progress',
                  rawInput: part.arguments,
                });
              }
            }
          } else if (message.role === 'toolResult')
            await update(c.id, {
              sessionUpdate: 'tool_call_update',
              toolCallId: String(message.toolCallId),
              status: message.isError ? 'failed' : 'completed',
              content: parts
                .filter((p) => p.type === 'text')
                .map((p) => ({ type: 'content', content: p })),
            });
        }
        c.seen.add(item.entry_id);
      }
      offset = page.next_offset;
    }
  };
  const controller = async (c: Connection, takeover = false) => {
    if (!c.lease) c.lease = await acquireControl(socket, c.id, c.client, takeover);
    return { client_id: c.client, token: c.lease.token };
  };
  const cancel = async (c: Connection) => {
    const actor = await controller(c);
    const view = await snapshot(c.id);
    for (const work of view.attempts.filter((a) =>
      ['accepted', 'dispatching', 'running'].includes(a.state),
    )) {
      const outbox = new Outbox(state, c.id);
      outbox.enqueueCancellation(work.id, (await snapshot(c.id)).revision);
      await outbox.flush(socket, c.id, actor);
    }
  };
  const approvals = async (c: Connection, view: SessionSnapshot) => {
    for (const approval of view.approvals.filter((a) => a.state === 'pending')) {
      if (c.permissions.has(approval.id)) continue;
      const op = await call<Operation>(socket, `/v1/operations/${approval.operation_id}`);
      c.permissions.add(approval.id);
      const id = 'permission:' + randomUUID();
      const toolCall = {
        toolCallId: 'salaam-operation:' + op.id,
        title: op.kind + ': ' + op.target,
        kind: 'other',
        status: 'pending',
        rawInput: {
          target: op.target,
          value: op.value,
          targetVersion: op.target_version,
          operationDigest: op.operation_digest,
          approvalRevision: approval.revision,
        },
      };
      await update(c.id, { sessionUpdate: 'tool_call', ...toolCall });
      permissionReplies.set(id, async (result) => {
        const outcome = object(result.outcome);
        if (outcome.outcome === 'cancelled') {
          if (c.lease) await cancel(c);
          return;
        }
        if (
          outcome.outcome !== 'selected' ||
          !['allow-once', 'reject-once'].includes(String(outcome.optionId))
        )
          throw new Error('Invalid permission outcome');
        const decide = async () => {
          const outbox = new Outbox(state, c.id);
          outbox.enqueueDecision(
            approval.id,
            approval.operation_digest,
            approval.revision,
            outcome.optionId === 'allow-once' ? 'approve' : 'deny',
          );
          await outbox.flush(socket, c.id);
        };
        c.decisions = c.decisions.catch(() => {}).then(decide);
        await c.decisions;
      });
      await send({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: c.id,
          toolCall,
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
    }
  };
  const refresh = (c: Connection): Promise<void> => {
    c.dirty = true;
    if (c.refresh) return c.refresh;
    c.refresh = (async () => {
      while (c.dirty && !closed) {
        c.dirty = false;
        const view = await snapshot(c.id);
        await replay(c, true);
        await approvals(c, view);
        delete c.failed;
        for (const op of view.operations) {
          const status =
            op.state === 'succeeded'
              ? 'completed'
              : ['failed_definite', 'cancelled_before_dispatch', 'outcome_unknown'].includes(
                    op.state,
                  )
                ? 'failed'
                : 'in_progress';
          if (c.operations.get(op.id) !== status) {
            c.operations.set(op.id, status);
            await update(c.id, {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'salaam-operation:' + op.id,
              title: op.kind + ': ' + op.target,
              status,
            });
          }
        }
      }
    })().finally(() => {
      delete c.refresh;
    });
    return c.refresh;
  };
  const watch = (c: Connection) => {
    if (closed) return;
    const feed = subscribe(socket, c.id, c.cursor, (event) => {
      c.cursor = event.seq;
      if (event.kind === 'tool.started' || event.kind === 'tool.finished') {
        const p = event.payload as {
          tool_call_id?: string;
          parent_tool_call_id?: string;
          tool?: string;
          input?: string;
          failed?: boolean;
        };
        if (typeof p.tool_call_id === 'string') {
          const started = event.kind === 'tool.started';
          const fresh = !c.liveTools.has(p.tool_call_id);
          c.liveTools.add(p.tool_call_id);
          void update(c.id, {
            sessionUpdate: started && fresh ? 'tool_call' : 'tool_call_update',
            toolCallId: p.tool_call_id,
            title: p.tool ?? 'Tool',
            kind: 'other',
            status: started ? 'in_progress' : p.failed ? 'failed' : 'completed',
            ...(started && p.input ? { rawInput: p.input } : {}),
            ...(p.parent_tool_call_id
              ? { _meta: { 'salaam.dev/parentToolCallId': p.parent_tool_call_id } }
              : {}),
          }).catch((error) => {
            c.failed = error;
          });
        }
      }
      if (
        [
          'transcript.synced',
          'approval.requested',
          'approval.decided',
          'operation.succeeded',
          'operation.outcome_unknown',
        ].includes(event.kind)
      )
        void refresh(c).catch((error) => {
          c.failed = error;
        });
    });
    c.feed = feed;
    void feed.done
      .catch(() => {})
      .finally(() => {
        if (!closed) {
          const retry = setTimeout(() => {
            void refresh(c)
              .catch((error) => {
                c.failed = error;
              })
              .finally(() => watch(c));
          }, 250);
          retry.unref();
        }
      });
  };
  const connect = async (id: string, replayHistory: boolean, params: Json) => {
    if (sessions.has(id)) throw new Error('Session already connected on this transport');
    const view = await snapshot(id);
    if (view.cwd !== realpathSync(string(params.cwd, 'cwd')))
      throw new Error('Session working directory differs');
    const c: Connection = {
      id,
      client: randomUUID(),
      seen: new Set(),
      liveTools: new Set(),
      operations: new Map(),
      permissions: new Set(),
      cursor: view.seq,
      dirty: false,
      decisions: Promise.resolve(),
    };
    sessions.set(id, c);
    try {
      if (view.state !== 'ready') {
        const actor = await controller(
          c,
          object(params._meta ?? {})['salaam.dev/takeover'] === true,
        );
        await call(socket, `/v1/sessions/${id}/resume`, actor);
        const deadline = Date.now() + 15000;
        while (!closed) {
          const current = await snapshot(id);
          if (current.state === 'ready') break;
          if (current.state === 'unhealthy' || Date.now() > deadline)
            throw new Error(current.error ?? 'Worker readiness timed out');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      await replay(c, replayHistory, replayHistory);
      if (journal.pending(id).length) {
        const actor = await controller(
          c,
          object(params._meta ?? {})['salaam.dev/takeover'] === true,
        );
        await call(socket, `/v1/sessions/${id}/resume`, actor);
        for (const pending of journal.pending(id)) await journal.dispatch(socket, pending, actor);
      }
      await approvals(c, view);
      watch(c);
    } catch (error) {
      sessions.delete(id);
      c.feed?.close();
      if (c.lease)
        await call(socket, `/v1/sessions/${id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id: c.client,
          token: c.lease.token,
          expected_epoch: c.lease.epoch,
        }).catch(() => {});
      throw error;
    }
    return c;
  };
  const invoke = async (method: string, params: Json): Promise<unknown> => {
    if (method === 'initialize') {
      if (initialized) throw new Error('Already initialized');
      if (!Number.isSafeInteger(params.protocolVersion))
        throw new Error('Invalid protocol version');
      initialized = params.protocolVersion === 1;
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: 'salaam', title: 'Salaam', version: '0.1.0' },
        authMethods: [],
      };
    }
    if (!initialized) throw new Error('Initialize ACP v1 first');
    if (['session/new', 'session/load', 'session/resume'].includes(method)) {
      const cwd = string(params.cwd, 'cwd');
      if (
        !isAbsolute(cwd) ||
        !Array.isArray(params.mcpServers) ||
        params.mcpServers.length ||
        (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length)
      )
        throw new Error('Use an absolute cwd and no extra MCP servers/directories');
      if (method === 'session/new') {
        const coding = object(params._meta ?? {})['salaam.dev/coding'] ?? options.coding ?? false;
        if (typeof coding !== 'boolean') throw new Error('Coding selection must be a boolean.');
        if (coding) {
          const health = await call<{ coding_root?: string | null }>(socket, '/v1/health');
          if (!health.coding_root)
            throw new Error(
              'Start the service with --coding-root before creating a coding session.',
            );
        }
        const created = await call<{ id: string }>(socket, '/v1/sessions', {
          request_id: randomUUID(),
          cwd,
          coding,
        });
        await connect(created.id, false, params);
        return { sessionId: created.id };
      }
      await connect(string(params.sessionId, 'sessionId', 128), method === 'session/load', params);
      return {};
    }
    if (!['session/cancel', 'session/prompt'].includes(method))
      throw new ServiceError('method_not_found', 'Unsupported ACP method', 404);
    const c = sessions.get(string(params.sessionId, 'sessionId', 128));
    if (!c) throw new Error('Load or resume this session first');
    if (method === 'session/cancel') {
      await cancel(c);
      return {};
    }
    if (method !== 'session/prompt')
      throw new ServiceError('method_not_found', 'Unsupported ACP method', 404);
    if (!Array.isArray(params.prompt) || !params.prompt.length)
      throw new Error('Prompt content required');
    const input = params.prompt
      .map((value) => {
        const block = object(value);
        if (block.type === 'text') return string(block.text, 'text', 256 * 1024);
        if (block.type === 'resource_link')
          return `Resource reference ${string(block.name, 'name')}: ${string(block.uri, 'uri')}`;
        throw new Error('Only text and resource links are supported');
      })
      .join('\n');
    const meta = object(params._meta ?? {});
    const actor = await controller(c, meta['salaam.dev/takeover'] === true);
    await call(socket, `/v1/sessions/${c.id}/resume`, actor);
    const view = await snapshot(c.id);
    const logical =
      meta['salaam.dev/requestId'] === undefined
        ? randomUUID()
        : string(meta['salaam.dev/requestId'], 'requestId', 128);
    const record = journal.prepare(
      c.id,
      logical,
      input,
      view.revision,
      meta['salaam.dev/continuesAttemptId'] === undefined
        ? undefined
        : string(meta['salaam.dev/continuesAttemptId'], 'continuesAttemptId', 128),
    );
    const accepted = await journal.dispatch(socket, record, actor);
    while (!closed) {
      if (c.failed) throw c.failed;
      const attempt = await call<Attempt>(socket, `/v1/attempts/${accepted.attempt_id}`);
      await refresh(c);
      if (!['accepted', 'dispatching', 'running'].includes(attempt.state)) {
        if (attempt.state === 'interrupted' || attempt.state === 'failed')
          throw new Error(attempt.error ?? 'Attempt did not complete');
        return {
          stopReason: attempt.state === 'cancelled' ? 'cancelled' : 'end_turn',
          _meta: { 'salaam.dev/requestId': logical, 'salaam.dev/attemptId': attempt.id },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return { stopReason: 'cancelled' }; // Transport closed; no service cancellation is issued.
  };
  const renew = setInterval(() => {
    for (const c of sessions.values())
      if (c.lease) {
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
  }, 5000);
  let buffer = '';
  const handle = async (line: string) => {
    let id: unknown = null;
    let response = false;
    try {
      let value: Json;
      try {
        value = object(JSON.parse(line));
      } catch {
        await send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (value.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version');
      id = value.id;
      if (typeof value.method !== 'string') {
        response = true;
        if (typeof id === 'string' && permissionReplies.has(id)) {
          const respond = permissionReplies.get(id)!;
          permissionReplies.delete(id);
          if (value.error) return; // Leave durable approval pending on client failure.
          await respond(object(value.result));
        }
        return;
      }
      if (id !== undefined && typeof id !== 'string' && typeof id !== 'number')
        throw new Error('Invalid request ID');
      const key = JSON.stringify(id);
      if (id !== undefined) {
        if (activeRequests.has(key) || activeRequests.size >= 32)
          throw new Error('Request already active or transport busy');
        activeRequests.add(key);
      }
      try {
        const result = await invoke(value.method, object(value.params ?? {}));
        if (id !== undefined) await send({ jsonrpc: '2.0', id, result });
      } finally {
        if (id !== undefined) activeRequests.delete(key);
      }
    } catch (error) {
      if (id !== undefined && !response)
        await send({
          jsonrpc: '2.0',
          id,
          error: {
            code:
              error instanceof ServiceError && error.code === 'method_not_found' ? -32601 : -32602,
            message: (error as Error).message,
          },
        });
      else console.error('ACP notification rejected:', (error as Error).message);
    }
  };
  const done = new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        console.error('ACP input exceeds 1 MiB');
        process.stdin.destroy();
        resolve();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) void handle(line);
      }
    });
    process.stdin.once('end', resolve);
    process.stdin.once('error', resolve);
    process.stdout.once('error', resolve);
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  try {
    await done;
  } finally {
    closed = true;
    clearInterval(renew);
    permissionReplies.clear();
    for (const c of sessions.values()) {
      c.feed?.close();
      if (c.lease)
        await call(socket, `/v1/sessions/${c.id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id: c.client,
          token: c.lease.token,
          expected_epoch: c.lease.epoch,
        }).catch(() => {});
    }
  }
}
