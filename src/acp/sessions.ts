// ACP session lifecycle: initialize, and session/new, session/load and session/resume connecting
// one service session to this transport.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { call, object, string, VERSION, ServiceError } from '../core/index.js';
import { validateManagedMcpDeclarations } from '../mcp/index.js';
import {
  controller,
  permissions,
  releaseLease,
  snapshot,
  update,
  type AcpContext,
  type Connection,
  type Json,
} from './context.js';
import { DESK_COMMANDS, deskRoute } from './desk.js';
import { deskState } from './desk-session.js';
import { replay } from './history.js';
import { approvals } from './approvals.js';
import { cancellationReceipts, promptReceipt } from './receipts.js';
import { refresh, sendPlan, watch } from './refresh.js';

/** How long a resumed session's worker has to become ready, and how often it is checked. */
const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 50;

export function initialize(ctx: AcpContext, params: Json): Json {
  if (ctx.initialized) throw new Error('Already initialized');
  if (!Number.isSafeInteger(params.protocolVersion)) throw new Error('Invalid protocol version');
  ctx.initialized = params.protocolVersion === 1;
  const advertised = object(object(params.clientCapabilities ?? {})._meta ?? {})[
    'salaam.dev/features'
  ];
  ctx.wantsReceipts =
    advertised !== null &&
    typeof advertised === 'object' &&
    object(advertised).promptReceipts === 1;
  const execution = object(object(params.clientCapabilities ?? {})._meta ?? {})[
    'salaam.dev/executionFeatures'
  ];
  ctx.wantsCancellations =
    execution !== null &&
    typeof execution === 'object' &&
    object(execution).cancellationReceipts === 1;
  ctx.wantsTypedStops =
    execution !== null && typeof execution === 'object' && object(execution).failures === 1;
  return {
    _meta: {
      ...(ctx.bound?.managed_mcp
        ? {
            'salaam.dev/managedMcp': {
              version: 1,
              servers: ctx.bound.managed_mcp.servers.map((s) => s.name),
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
      mcpCapabilities: { http: !!ctx.bound?.managed_mcp, sse: false },
    },
    agentInfo: { name: 'salaam', title: 'Salaam', version: VERSION },
    authMethods: [],
  };
}

/** session/new, session/load or session/resume. */
export async function openSession(ctx: AcpContext, method: string, params: Json): Promise<unknown> {
  const { bound, options } = ctx;
  const cwd = string(params.cwd, 'cwd');
  // An editor forwards its own MCP servers. A desk session never connects to them, so it
  // ignores the list; station work keeps the exact node assignment check.
  const desk = !bound && (object(params._meta ?? {})['salaam.dev/local'] ?? options.local) === true;
  if (desk && Array.isArray(params.mcpServers)) {
    if (params.mcpServers.length && !ctx.ignoredMcp) {
      ctx.ignoredMcp = true;
      console.error(
        `Salaam does not use the editor's MCP servers; ignored ${params.mcpServers.length}.`,
      );
    }
  } else validateManagedMcpDeclarations(params.mcpServers, bound?.managed_mcp);
  if (
    !isAbsolute(cwd) ||
    (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length)
  )
    throw new Error('Use an absolute cwd and no extra directories');
  if (method === 'session/new') return newSession(ctx, cwd, params);
  const c = await connect(
    ctx,
    string(params.sessionId, 'sessionId', 128),
    method === 'session/load',
    params,
  );
  return await deskState(ctx, c);
}

async function newSession(ctx: AcpContext, cwd: string, params: Json): Promise<Json> {
  const { bound, options } = ctx;
  if (bound) {
    if (options.coding || object(params._meta ?? {})['salaam.dev/coding'])
      throw Error('AgentPod admission has no coding authority');
    await call(ctx.socket, '/v1/agentpod/attach', {
      admission_id: ctx.admission,
      token: ctx.admissionToken,
    });
    await connect(ctx, bound.session_id, false, params);
    return { sessionId: bound.session_id };
  }
  const coding = object(params._meta ?? {})['salaam.dev/coding'] ?? options.coding ?? false;
  if (typeof coding !== 'boolean') throw new Error('Coding selection must be a boolean.');
  const local = object(params._meta ?? {})['salaam.dev/local'] ?? options.local ?? false;
  if (typeof local !== 'boolean') throw new Error('Local selection must be a boolean.');
  if (local && coding)
    throw new Error('Choose a local session in the project folder or a guarded coding copy.');
  if (local) {
    // Your desk session in the project folder itself, the same as salaam in a terminal there.
    const health = await call<{ provider_route?: { provider: string } }>(ctx.socket, '/v1/health');
    const route = deskRoute(health.provider_route?.provider);
    const created = await call<{ id: string }>(ctx.socket, '/v1/sessions', {
      request_id: randomUUID(),
      cwd,
      local_workspace: true,
      local_coding: true,
      ...(route ? { route } : {}),
    });
    const c = await connect(ctx, created.id, false, params);
    return { sessionId: created.id, ...(await deskState(ctx, c)) };
  }
  if (coding) {
    const health = await call<{ coding_root?: string | null }>(ctx.socket, '/v1/health');
    if (!health.coding_root)
      throw new Error('Start the service with --coding-root before creating a coding session.');
  }
  const created = await call<{ id: string }>(ctx.socket, '/v1/sessions', {
    request_id: randomUUID(),
    cwd,
    coding,
  });
  await connect(ctx, created.id, false, params);
  return { sessionId: created.id };
}

export async function connect(
  ctx: AcpContext,
  id: string,
  replayHistory: boolean,
  params: Json,
): Promise<Connection> {
  const { bound, journal } = ctx;
  if (ctx.sessions.has(id)) throw new Error('Session already connected on this transport');
  const view = await snapshot(ctx, id);
  if (
    (bound && bound.session_id !== id) ||
    (view.agentpod_admission_id && view.agentpod_admission_id !== ctx.admission)
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
  ctx.sessions.set(id, c);
  try {
    if (!bound) {
      const current = await permissions(ctx, id).catch(() => undefined);
      if (current?.coding && current.configurable) {
        const rules = await call<{ applies: boolean }>(
          ctx.socket,
          `/v1/sessions/${id}/approval-rules`,
        ).catch(() => ({ applies: false }));
        c.desk = { rules: rules.applies };
      }
    }
    if (view.state !== 'ready') await resumeUntilReady(ctx, c, params);
    if (ctx.strictWork && c.lease) {
      // Release only this adapter's exact bootstrap lease. Never steal or revoke
      // another terminal's control to make a work grant succeed.
      await releaseLease(ctx, c, c.lease);
      delete c.lease;
    }
    if (ctx.strictWork && journal.pending(id).length)
      throw new ServiceError(
        'work_control_owned',
        'Pending interactive prompts cannot enter strict work',
      );
    await replay(ctx, c, replayHistory, replayHistory);
    if (journal.pending(id).length) {
      const actor = await controller(
        ctx,
        c,
        object(params._meta ?? {})['salaam.dev/takeover'] === true,
      );
      await call(ctx.socket, `/v1/sessions/${id}/resume`, actor);
      for (const pending of journal.pending(id)) await journal.dispatch(ctx.socket, pending, actor);
    }
    for (const record of journal.records(id))
      if (record.receipt)
        await promptReceipt(ctx, id, record.request_id, record.receipt.attempt_id);
    if (ctx.wantsCancellations) await cancellationReceipts(ctx, c);
    if (c.desk) await deskState(ctx, c);
    await approvals(ctx, c, view, (x) => refresh(ctx, x));
    // The plan is visible before any step runs.
    await sendPlan(ctx, c, view.work_task ?? null);
    watch(ctx, c);
    if (c.desk)
      // After the response, so the editor knows the session first.
      setImmediate(
        () =>
          void update(ctx, id, {
            sessionUpdate: 'available_commands_update',
            availableCommands: DESK_COMMANDS,
          }).catch(() => {}),
      );
  } catch (error) {
    ctx.sessions.delete(id);
    c.feed?.close();
    if (c.lease) await releaseLease(ctx, c, c.lease).catch(() => {});
    throw error;
  }
  return c;
}

/** Start the session's worker and wait for it to become ready. */
async function resumeUntilReady(ctx: AcpContext, c: Connection, params: Json): Promise<void> {
  const actor = await controller(
    ctx,
    c,
    object(params._meta ?? {})['salaam.dev/takeover'] === true,
    true,
  );
  await call(ctx.socket, `/v1/sessions/${c.id}/resume`, actor);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!ctx.closed) {
    const current = await snapshot(ctx, c.id);
    if (current.state === 'ready') break;
    if (current.state === 'unhealthy' || Date.now() > deadline)
      throw new Error(current.error ?? 'Worker readiness timed out');
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}
