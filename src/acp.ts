import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import { call } from './transport.js';
import { acquireControl, Outbox, subscribe, type Feed } from './attach.js';
import { AcpJournal } from './acp-journal.js';
import { VERSION } from './config.js';
import { acpFailure, AcpFailureError, toolMetadata } from './acp-outcome.js';
import type { CancellationReceipt } from './turn-cancellations.js';
import { validateManagedMcpDeclarations } from './mcp-acp.js';
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
}
/** ACP v1 newline-delimited stdio adapter. The daemon remains the only worker owner. */
export async function acp(state: string, options: { coding?: boolean } = {}): Promise<void> {
  const socket = join(state, 'operator.sock');
  const client = acpClientState(state);
  const journal = new AcpJournal(client);
  const admission = process.env.SALAAM_AGENTPOD_ADMISSION,
    admissionToken = process.env.SALAAM_AGENTPOD_TOKEN;
  delete process.env.SALAAM_AGENTPOD_ADMISSION;
  delete process.env.SALAAM_AGENTPOD_TOKEN;
  if (!!admission !== !!admissionToken)
    throw Error('AgentPod admission requires both credential fields');
  const bound = admission
    ? await call<{
        session_id: string;
        binding: import('./agentpod-protocol.js').AgentPodBinding;
        managed_mcp?: import('./mcp-work.js').McpWorkerBinding | null;
        work_control?: { version: 1; owner: 'superpipeline' };
      }>(socket, '/v1/agentpod/attach', { admission_id: admission, token: admissionToken })
    : undefined;
  const strictWork = bound?.work_control !== undefined;
  if (
    strictWork &&
    (JSON.stringify(bound?.work_control) !==
      JSON.stringify({ version: 1, owner: 'superpipeline' }) ||
      bound?.binding.run.source !== 'superpipeline')
  )
    throw new Error('Unsupported authenticated work control handoff');
  let closed = false,
    initialized = false,
    wantsReceipts = false,
    wantsCancellations = false,
    wantsTypedStops = false;
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
  const update = (id: string, value: Json) => {
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
    return send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: id, update: out },
    });
  };
  const promptReceipt = async (session: string, request: string, attemptId: string) => {
    if (!bound || !wantsReceipts) return;
    const attempt = await call<Attempt>(socket, `/v1/attempts/${attemptId}`);
    const state =
      attempt.state === 'completed' && attempt.outcome?.stopReason === 'end_turn'
        ? 'completed'
        : ['interrupted', 'failed', 'cancelled', 'completed'].includes(attempt.state)
          ? 'interrupted'
          : 'accepted';
    const connection = sessions.get(session);
    if (connection?.promptStates.get(request) === state) return;
    connection?.promptStates.set(request, state);
    await update(session, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        'salaam.dev/promptReceipt': { sessionId: session, requestId: request, attemptId, state },
      },
    });
  };
  const cancellationReceipt = async (c: Connection, receipt: CancellationReceipt) => {
    const value = JSON.stringify(receipt);
    if (c.cancellations.get(receipt.requestId) === value) return;
    c.cancellations.set(receipt.requestId, value);
    if (wantsCancellations)
      await update(c.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { 'salaam.dev/cancellationReceipt': receipt },
      });
  };
  const cancellationReceipts = async (c: Connection) => {
    for (const receipt of await call<CancellationReceipt[]>(
      socket,
      `/v1/sessions/${c.id}/cancellations`,
    ))
      await cancellationReceipt(c, receipt);
  };
  const text = (id: string, role: string, content: string, message: string, part = 0) =>
    update(id, {
      sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      messageId: message,
      _meta: { 'salaam.dev/sourcePart': part },
      content: { type: 'text', text: content },
    });
  const snapshot = (id: string) => call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
  const toolDetails = async (session: string, id: string, name: string, input: unknown) =>
    (await call<Json | null>(
      socket,
      `/v1/sessions/${session}/tool-metadata?call_id=${encodeURIComponent(id)}`,
    )) ?? toolMetadata(name, input);
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
            for (const [partIndex, part] of parts.entries()) {
              // The editor already displays its submitted prompt. User chunks belong
              // to explicit history loading, otherwise Zed renders a second copy.
              if (
                part.type === 'text' &&
                typeof part.text === 'string' &&
                (message.role !== 'user' || includeUsers)
              )
                await text(c.id, String(message.role), part.text, item.entry_id, partIndex);
              if (part.type === 'toolCall' && !c.liveTools.has(String(part.id))) {
                c.liveTools.add(String(part.id));
                await update(c.id, {
                  sessionUpdate: 'tool_call',
                  toolCallId: String(part.id),
                  title: String(part.name),
                  ...(await toolDetails(c.id, String(part.id), String(part.name), part.arguments)),
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
  const controller = async (c: Connection, takeover = false, bootstrap = false) => {
    if (strictWork && (!bootstrap || takeover))
      throw new ServiceError(
        'work_control_owned',
        'The authenticated work owner controls this session',
      );
    if (!c.lease) {
      c.controlPending ??= acquireControl(socket, c.id, c.client, takeover)
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
  };
  const cancel = async (
    c: Connection,
    request: string = randomUUID(),
    target: string | null = c.activePrompts.keys().next().value ?? null,
  ) => {
    const actor = await controller(c);
    const receipt = await call<CancellationReceipt>(socket, `/v1/sessions/${c.id}/cancellations`, {
      ...actor,
      request_id: request,
      target_request_id: target,
    });
    await cancellationReceipt(c, receipt);
  };
  const approvals = async (c: Connection, view: SessionSnapshot) => {
    if (strictWork) return; // Exact work decisions belong to the durable producer handshake.
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
          const outbox = new Outbox(client, c.id);
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
        if (wantsCancellations || c.cancellations.size) await cancellationReceipts(c);
        if (bound && wantsReceipts)
          for (const record of journal.records(c.id)) {
            if (
              record.receipt &&
              !['completed', 'interrupted'].includes(c.promptStates.get(record.request_id) ?? '')
            )
              await promptReceipt(c.id, record.request_id, record.receipt.attempt_id);
          }
        await approvals(c, view);
        const inbox = JSON.stringify(view.inbox ?? []);
        if (c.inboxDigest !== inbox && (inbox !== '[]' || c.inboxDigest !== undefined)) {
          c.inboxDigest = inbox;
          await update(c.id, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Salaam operator inbox: ' + inbox },
            _meta: { 'salaam.dev/inbox': view.inbox ?? [] },
          });
        }
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
          kind?: string;
          locations?: unknown[];
        };
        if (typeof p.tool_call_id === 'string') {
          const started = event.kind === 'tool.started';
          const fresh = !c.liveTools.has(p.tool_call_id);
          c.liveTools.add(p.tool_call_id);
          void update(c.id, {
            sessionUpdate: started && fresh ? 'tool_call' : 'tool_call_update',
            toolCallId: p.tool_call_id,
            title: p.tool ?? 'Tool',
            ...(started
              ? {
                  kind: p.kind ?? toolMetadata(p.tool ?? '', p.input).kind,
                  locations: p.locations ?? [],
                }
              : {}),
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
          'inbox.changed',
          'inbox.resolved',
          'inbox.acknowledged',
          'transcript.synced',
          'approval.requested',
          'approval.decided',
          'operation.succeeded',
          'operation.outcome_unknown',
          'turn.cancel_requested',
          'turn.cancel_status',
          'attempt.cancelled',
          'attempt.failed',
          'attempt.interrupted',
          'attempt.completed',
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
    if (
      (bound && bound.session_id !== id) ||
      (view.agentpod_admission_id && view.agentpod_admission_id !== admission)
    )
      throw Error('ACP transport differs from its bound AgentPod admission');
    if (view.cwd !== realpathSync(string(params.cwd, 'cwd')))
      throw new Error('Session working directory differs');
    const c: Connection = {
      id,
      client: randomUUID(),
      seen: new Set(),
      promptStates: new Map(),
      cancellations: new Map(),
      activePrompts: new Map(),
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
          true,
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
      if (strictWork && c.lease) {
        // Release only this adapter's exact bootstrap lease. Never steal or revoke
        // another terminal's control to make a work grant succeed.
        await call(socket, `/v1/sessions/${id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id: c.client,
          token: c.lease.token,
          expected_epoch: c.lease.epoch,
        });
        delete c.lease;
      }
      if (strictWork && journal.pending(id).length)
        throw new ServiceError(
          'work_control_owned',
          'Pending interactive prompts cannot enter strict work',
        );
      await replay(c, replayHistory, replayHistory);
      if (journal.pending(id).length) {
        const actor = await controller(
          c,
          object(params._meta ?? {})['salaam.dev/takeover'] === true,
        );
        await call(socket, `/v1/sessions/${id}/resume`, actor);
        for (const pending of journal.pending(id)) await journal.dispatch(socket, pending, actor);
      }
      for (const record of journal.records(id))
        if (record.receipt) await promptReceipt(id, record.request_id, record.receipt.attempt_id);
      if (wantsCancellations) await cancellationReceipts(c);
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
      const advertised = object(object(params.clientCapabilities ?? {})._meta ?? {})[
        'salaam.dev/features'
      ];
      wantsReceipts =
        advertised !== null &&
        typeof advertised === 'object' &&
        object(advertised).promptReceipts === 1;
      const execution = object(object(params.clientCapabilities ?? {})._meta ?? {})[
        'salaam.dev/executionFeatures'
      ];
      wantsCancellations =
        execution !== null &&
        typeof execution === 'object' &&
        object(execution).cancellationReceipts === 1;
      wantsTypedStops =
        execution !== null && typeof execution === 'object' && object(execution).failures === 1;
      return {
        _meta: {
          ...(bound?.managed_mcp
            ? {
                'salaam.dev/managedMcp': {
                  version: 1,
                  servers: bound.managed_mcp.servers.map((s) => s.name),
                },
              }
            : {}),
          'salaam.dev/features': { promptReceipts: 1, updateIds: 1 },
          'salaam.dev/executionFeatures': {
            failures: 1,
            cancellationReceipts: 1,
            toolSemantics: 1,
          },
        },
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: !!bound?.managed_mcp, sse: false },
        },
        agentInfo: { name: 'salaam', title: 'Salaam', version: VERSION },
        authMethods: [],
      };
    }
    if (!initialized) throw new Error('Initialize ACP v1 first');
    if (method === '_salaam/inbox/list')
      return call(socket, '/v1/inbox?offset=' + encodeURIComponent(String(params.offset ?? 0)));
    if (method === '_salaam/inbox/ack') {
      const id = string(params.id, 'id', 128),
        item = await call<{ session_id: string }>(socket, `/v1/inbox/${id}`),
        c = sessions.get(item.session_id);
      if (!c) throw new Error('Connect the attention session before acknowledgement');
      return call(socket, `/v1/inbox/${id}/ack`, {
        ...(await controller(c)),
        request_id: string(params.request_id, 'request_id', 128),
        expected_revision: params.expected_revision,
      });
    }
    if (['session/new', 'session/load', 'session/resume'].includes(method)) {
      const cwd = string(params.cwd, 'cwd');
      validateManagedMcpDeclarations(params.mcpServers, bound?.managed_mcp);
      if (
        !isAbsolute(cwd) ||
        (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length)
      )
        throw new Error('Use an absolute cwd and no extra directories');
      if (method === 'session/new') {
        if (bound) {
          if (options.coding || object(params._meta ?? {})['salaam.dev/coding'])
            throw Error('AgentPod admission has no coding authority');
          await call(socket, '/v1/agentpod/attach', {
            admission_id: admission,
            token: admissionToken,
          });
          await connect(bound.session_id, false, params);
          return { sessionId: bound.session_id };
        }
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
      const meta = object(params._meta ?? {});
      await cancel(
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
    const logical =
      meta['salaam.dev/requestId'] === undefined
        ? randomUUID()
        : string(meta['salaam.dev/requestId'], 'requestId', 128);
    if (c.activePrompts.size && !c.activePrompts.has(logical))
      throw new ServiceError('worker_busy', 'A prompt is already active on this transport');
    c.activePrompts.set(logical, (c.activePrompts.get(logical) ?? 0) + 1);
    try {
      const actor = await controller(c, meta['salaam.dev/takeover'] === true);
      await call(socket, `/v1/sessions/${c.id}/resume`, actor);
      const view = await snapshot(c.id);
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
      await promptReceipt(c.id, logical, accepted.attempt_id);
      while (!closed) {
        if (c.failed) throw c.failed;
        const attempt = await call<Attempt>(socket, `/v1/attempts/${accepted.attempt_id}`);
        await refresh(c);
        if (!['accepted', 'dispatching', 'running'].includes(attempt.state)) {
          await promptReceipt(c.id, logical, accepted.attempt_id);
          const context = { sessionId: c.id, requestId: logical, attemptId: attempt.id };
          const failure = attempt.outcome?.failure;
          if (
            attempt.state === 'interrupted' ||
            (attempt.state === 'failed' &&
              ((bound && !wantsTypedStops) ||
                !['refusal', 'max_tokens'].includes(attempt.outcome?.stopReason ?? '')))
          )
            throw new AcpFailureError(
              failure
                ? { ...failure, ...context }
                : acpFailure(
                    new ServiceError(
                      'attempt_interrupted',
                      attempt.error ?? 'Attempt did not complete',
                    ),
                    context,
                  ),
            );
          if (attempt.state === 'completed' && !attempt.outcome)
            throw new AcpFailureError(
              acpFailure(
                new ServiceError(
                  'legacy_outcome_unverified',
                  'This saved turn predates typed outcomes; inspect its history before starting new work',
                ),
                context,
              ),
            );
          return {
            stopReason:
              attempt.state === 'cancelled'
                ? 'cancelled'
                : (attempt.outcome?.stopReason ?? 'end_turn'),
            _meta: {
              'salaam.dev/requestId': logical,
              'salaam.dev/attemptId': attempt.id,
              ...(failure ? { 'salaam.dev/failure': { ...failure, ...context } } : {}),
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return { stopReason: 'cancelled' }; // Transport closed; no service cancellation is issued.
    } catch (error) {
      throw new AcpFailureError(acpFailure(error, { sessionId: c.id, requestId: logical }));
    } finally {
      const count = (c.activePrompts.get(logical) ?? 1) - 1;
      if (count) c.activePrompts.set(logical, count);
      else c.activePrompts.delete(logical);
    }
  };
  const cancellationPoll = setInterval(() => {
    for (const c of sessions.values())
      if ([...c.cancellations.values()].some((value) => JSON.parse(value).state !== 'confirmed'))
        void refresh(c).catch((error) => {
          c.failed = error;
        });
  }, 250);
  cancellationPoll.unref();
  const renew = setInterval(() => {
    for (const c of sessions.values())
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
              error instanceof ServiceError && error.code === 'method_not_found'
                ? -32601
                : error instanceof AcpFailureError
                  ? -32000
                  : error instanceof ServiceError &&
                      !['invalid_field', 'invalid_json'].includes(error.code)
                    ? -32000
                    : -32602,
            message: acpFailure(error).message,
            data: { 'salaam.dev/failure': acpFailure(error) },
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
    clearInterval(cancellationPoll);
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

/** A launcher-profile daemon's state belongs to root; its ACP clients keep their own
 * journal and outbox in the caller's state home, keyed by the daemon state path. */
export function acpClientState(state: string, env: NodeJS.ProcessEnv = process.env): string {
  let own = false;
  try {
    own = statSync(state).uid === process.getuid?.();
  } catch {}
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
