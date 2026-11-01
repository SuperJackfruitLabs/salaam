import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { ManagedWork } from '../execution/managed.js';
import type { Artifacts } from '../store/artifacts.js';
import { McpAdmission } from './admission.js';
import { ManagedHttpMcp, McpHttpFailure, McpInputFailure, type McpReturnedResult } from './http.js';
import {
  mcpAssignment,
  redactMcpData,
  type McpAssignment,
  type McpProfile,
  type McpServerPin,
} from './protocol.js';
import {
  canonical,
  digest,
  object,
  ServiceError,
  string,
  type Operation,
} from '../core/protocol.js';
import type { AgentPodBinding } from '../agentpod/protocol.js';
import { workTraceHeader } from '../execution/trace.js';

export interface McpConnection {
  connect(): Promise<void>;
  describe?(): Record<string, unknown>[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend: () => void,
    traceparent?: string,
  ): Promise<McpReturnedResult>;
  close(): Promise<void>;
}
export interface McpWorkOptions {
  admission: McpAdmission;
  current(session: string): AgentPodBinding;
  assertActive(session: string, epoch: number, attempt: string): void;
  failed(session: string, error: Error): void;
  /** Trusted test seam; never configurable by ACP or a worker. */
  connection?: (
    server: McpAssignment['servers'][number],
    pin: McpServerPin,
    limits: McpProfile['limits'],
  ) => McpConnection;
}
export interface McpCall {
  id: string;
  session_id: string;
  worker_epoch: number;
  attempt_id: string;
  tool_call_id: string;
  input_digest: string;
  binding_digest: string;
  profile_digest: string;
  assignment_digest: string;
  credential_generation: number;
  server_name: string;
  tool_name: string;
  policy: 'read' | 'approval';
  arguments_json: string;
  operation_id: string | null;
  state: string;
  result_artifact: string | null;
  error: string | null;
  revision: number;
  created_at: number;
}
export type McpWorkerBinding = ReturnType<McpAdmission['accept']>;
type View = McpWorkerBinding;
interface Assigned {
  assignment: McpAssignment;
  view: View;
}
interface Active {
  session: string;
  attempt: string;
  controller: AbortController;
  client?: McpConnection;
  secrets: string[];
  done: Promise<void>;
  closing?: Promise<void>;
  invoking?: boolean;
}
const pending = (state: string) => state === 'prepared' || state === 'dispatching';

/** Durable calls, distinct from transport delivery and from verified product effects. */
export class McpWork {
  private assignments = new Map<string, Assigned>();
  private active = new Map<string, Active>();
  private fatal = new Set<string>();
  private stopFailures = new Set<string>();
  private readiness = new Map<string, { done: Promise<View>; clients: Set<McpConnection> }>();
  private catalogs = new Map<
    string,
    { assignment: string; servers: Record<string, Record<string, unknown>[]> }
  >();
  private closing = false;
  private assertOwned = (operation: Operation) => this.assertOperation(operation);
  private unregisterOwner: () => void;
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly artifacts: Artifacts,
    readonly options: McpWorkOptions,
  ) {
    this.unregisterOwner = managed.registerMcpController('managed-http', {
      owns: (op) =>
        !!this.store.db.prepare('SELECT 1 FROM mcp_calls WHERE operation_id=?').get(op.id),
      assert: this.assertOwned,
      assertSettled: (op) => {
        const call = this.ownedCall(op);
        if (this.active.has(call.id) || this.stopFailures.has(call.session_id))
          throw new ServiceError(
            'mcp_resources_unconfirmed',
            'MCP local resource cleanup is unconfirmed',
          );
      },
    });
  }
  get(id: string): McpCall {
    const row = this.store.db.prepare('SELECT * FROM mcp_calls WHERE id=?').get(id) as unknown as
      McpCall | undefined;
    if (!row) throw new ServiceError('not_found', 'MCP call not found', 404);
    return row;
  }
  private change(
    call: McpCall,
    state: string,
    error: string | null = null,
    artifact: string | null = null,
  ): void {
    this.store.db
      .prepare(
        'UPDATE mcp_calls SET state=?,error=?,result_artifact=COALESCE(?,result_artifact),revision=revision+1 WHERE id=?',
      )
      .run(state, error, artifact, call.id);
    this.store.event(call.session_id, 'mcp.' + state, {
      call_id: call.id,
      attempt_id: call.attempt_id,
      operation_id: call.operation_id,
      error,
      result_artifact: artifact,
    });
  }
  assign(session: string, input: unknown): View {
    const assignment = mcpAssignment(input),
      view = this.options.admission.accept(assignment, this.options.current(session));
    let changed = false;
    this.store.transaction(() => {
      const previous = this.store.db
        .prepare(
          'SELECT credential_generation,assignment_digest FROM mcp_assignments WHERE session_id=?',
        )
        .get(session);
      if (
        previous &&
        (Number(previous.credential_generation) > assignment.credential_generation ||
          (Number(previous.credential_generation) === assignment.credential_generation &&
            previous.assignment_digest !== view.assignment_digest))
      )
        throw new ServiceError(
          'mcp_generation_conflict',
          'MCP credential generation is stale or binds different configuration',
        );
      if (previous?.assignment_digest === view.assignment_digest) return;
      changed = true;
      for (const row of this.store.db
        .prepare(
          "SELECT DISTINCT attempt_id FROM mcp_calls WHERE session_id=? AND state IN ('prepared','dispatching')",
        )
        .all(session))
        this.cancelInTransaction(String(row.attempt_id), 'mcp_assignment_changed');
      this.store.db
        .prepare(
          'INSERT INTO mcp_assignments VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET credential_generation=excluded.credential_generation,assignment_digest=excluded.assignment_digest,view=excluded.view',
        )
        .run(session, assignment.credential_generation, view.assignment_digest, canonical(view));
      this.store.event(session, 'mcp.assigned', view);
    });
    this.assignments.set(session, { assignment, view });
    if (changed) {
      this.catalogs.delete(session);
      for (const client of this.readiness.get(session)?.clients ?? [])
        void this.closeClient(session, client).catch(() => {});
      for (const active of this.active.values()) if (active.session === session) this.abort(active);
    }
    if (!this.store.hasUnknown(session)) this.fatal.delete(session);
    return view;
  }
  /** Readiness inspects the actual pinned protocol/catalog; it grants no tools/call. */
  ready(session: string): Promise<View> {
    const existing = this.readiness.get(session);
    if (existing) return existing.done;
    const job = {
      clients: new Set<McpConnection>(),
      done: Promise.resolve(null as unknown as View),
    };
    this.readiness.set(session, job);
    let checkedAssignment: string | undefined;
    job.done = (async () => {
      try {
        const assigned = this.live(session),
          profile = this.options.admission.profile();
        checkedAssignment = assigned.view.assignment_digest;
        const servers: Record<string, Record<string, unknown>[]> = {};
        for (const pin of profile.servers) {
          const server = assigned.assignment.servers.find((s) => s.name === pin.name)!;
          const client =
            this.options.connection?.(server, pin, profile.limits) ??
            new ManagedHttpMcp(server, pin, profile.limits);
          job.clients.add(client);
          try {
            await client.connect();
            if (!client.describe) throw new Error('MCP readiness catalog unavailable');
            servers[pin.name] = client.describe();
          } finally {
            await this.closeClient(session, client);
            job.clients.delete(client);
          }
          this.assertBinding(session, assigned.view);
        }
        this.catalogs.set(session, { assignment: assigned.view.assignment_digest, servers });
        return assigned.view;
      } catch (error) {
        if (
          !checkedAssignment ||
          this.assignments.get(session)?.view.assignment_digest === checkedAssignment
        )
          this.fail(session, error as Error);
        throw new ServiceError(
          'mcp_readiness_failed',
          'Required MCP protocol and catalog readiness failed',
        );
      } finally {
        this.readiness.delete(session);
      }
    })();
    return job.done;
  }
  assertBinding(session: string, binding: View): void {
    if (canonical(this.live(session).view) !== canonical(binding))
      throw new ServiceError(
        'mcp_assignment_changed',
        'Worker MCP assignment changed; restart required',
      );
  }
  describe(session: string, binding: View, server?: string, tool?: string): unknown {
    this.assertBinding(session, binding);
    const catalog = this.catalogs.get(session);
    if (!catalog || catalog.assignment !== binding.assignment_digest)
      throw new ServiceError('mcp_not_ready', 'MCP catalog has not passed readiness');
    if (server === undefined) return structuredClone(binding.servers);
    const tools = catalog.servers[server];
    if (!tools) throw new ServiceError('invalid_mcp_server', 'MCP server is not admitted', 400);
    if (tool === undefined) return tools.map((t) => ({ name: t.name, description: t.description }));
    const definition = tools.find((t) => t.name === tool);
    if (!definition) throw new ServiceError('invalid_mcp_tool', 'MCP tool is not admitted', 400);
    return structuredClone(definition);
  }
  private live(session: string): Assigned {
    if (this.closing || this.fatal.has(session) || this.stopFailures.has(session))
      throw new ServiceError('mcp_unavailable', 'MCP execution controller is unavailable');
    const assigned = this.assignments.get(session);
    if (!assigned)
      throw new ServiceError('mcp_unassigned', 'No private MCP assignment is installed');
    const checked = this.options.admission.accept(
      assigned.assignment,
      this.options.current(session),
    );
    const saved = this.store.db
      .prepare(
        'SELECT assignment_digest,credential_generation FROM mcp_assignments WHERE session_id=?',
      )
      .get(session);
    if (
      !saved ||
      saved.assignment_digest !== checked.assignment_digest ||
      Number(saved.credential_generation) !== checked.credential_generation
    )
      throw new ServiceError('mcp_assignment_changed', 'MCP assignment changed');
    return assigned;
  }
  private input(session: string, epoch: number, attempt: string, call: string, args: unknown) {
    const b = object(args),
      value = {
        server: string(b.server, 'MCP server', 128),
        tool: string(b.tool, 'MCP tool', 128),
        arguments: object(b.arguments),
      };
    if (canonical(value) !== canonical(b))
      throw new ServiceError('invalid_mcp_call', 'Unexpected MCP call field', 400);
    return {
      value,
      encoded: canonical(value.arguments),
      fingerprint: digest({ session, epoch, attempt, call, ...value }),
    };
  }
  private context(call: McpCall): string {
    return digest({
      id: call.id,
      session: call.session_id,
      epoch: call.worker_epoch,
      attempt: call.attempt_id,
      tool_call: call.tool_call_id,
      input: call.input_digest,
      authority: call.binding_digest,
      profile: call.profile_digest,
      assignment: call.assignment_digest,
      generation: call.credential_generation,
      server: call.server_name,
      tool: call.tool_name,
      policy: call.policy,
    });
  }
  private bound(call: McpCall): Assigned {
    this.options.assertActive(call.session_id, call.worker_epoch, call.attempt_id);
    const assigned = this.live(call.session_id);
    if (
      assigned.view.assignment_digest !== call.assignment_digest ||
      assigned.view.binding_digest !== call.binding_digest ||
      assigned.view.profile_digest !== call.profile_digest ||
      assigned.view.credential_generation !== call.credential_generation
    )
      throw new ServiceError(
        'mcp_assignment_changed',
        'MCP call no longer binds the current assignment',
      );
    const input = this.input(
      call.session_id,
      call.worker_epoch,
      call.attempt_id,
      call.tool_call_id,
      {
        server: call.server_name,
        tool: call.tool_name,
        arguments: JSON.parse(call.arguments_json),
      },
    );
    if (input.fingerprint !== call.input_digest)
      throw new ServiceError('mcp_binding_changed', 'MCP call integrity changed');
    return assigned;
  }
  private ownedCall(op: Operation): McpCall {
    const row = this.store.db.prepare('SELECT id FROM mcp_calls WHERE operation_id=?').get(op.id);
    if (!row) throw new ServiceError('mcp_binding_changed', 'MCP permission has no call owner');
    const call = this.get(String(row.id));
    if (
      op.session_id !== call.session_id ||
      op.worker_epoch !== call.worker_epoch ||
      op.attempt_id !== call.attempt_id ||
      op.tool_call_id !== call.tool_call_id ||
      op.target !== call.server_name + '/' + call.tool_name ||
      op.value !== call.arguments_json ||
      op.target_version !== this.context(call)
    )
      throw new ServiceError('mcp_binding_changed', 'MCP permission differs from its call owner');
    return call;
  }
  private assertOperation(op: Operation): void {
    this.bound(this.ownedCall(op));
  }
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    toolCall: string,
    args: unknown,
  ): McpCall {
    string(toolCall, 'MCP tool call', 512);
    const input = this.input(session, epoch, attempt, toolCall, args);
    const old = this.store.db
      .prepare(
        'SELECT id,input_digest FROM mcp_calls WHERE session_id=? AND worker_epoch=? AND tool_call_id=?',
      )
      .get(session, epoch, toolCall);
    if (old) {
      if (old.input_digest !== input.fingerprint)
        throw new ServiceError('mcp_call_conflict', 'MCP tool call already binds different input');
      return this.get(String(old.id));
    }
    return this.store.transaction(() => {
      this.options.assertActive(session, epoch, attempt);
      if (this.store.hasUnknown(session))
        throw new ServiceError('operation_blocked', 'Unresolved effects block new MCP calls');
      const assigned = this.live(session),
        profile = this.options.admission.profile();
      const pin = profile.servers
        .find((s) => s.name === input.value.server)
        ?.tools.find((t) => t.name === input.value.tool);
      if (!pin)
        throw new ServiceError('mcp_tool_unadmitted', 'MCP tool is outside the reviewed profile');
      if (Buffer.byteLength(input.encoded) + 256 > profile.limits.request_bytes)
        throw new ServiceError('mcp_input_limit', 'MCP input exceeds its reviewed bound');
      for (const server of assigned.assignment.servers)
        for (const header of server.headers)
          if (
            [
              header.value,
              encodeURIComponent(header.value),
              Buffer.from(header.value).toString('base64'),
            ].some((s) => input.encoded.includes(s))
          )
            throw new ServiceError(
              'mcp_private_input',
              'Private MCP credentials cannot enter tool arguments',
            );
      const count = this.store.db
        .prepare('SELECT count(*) AS n FROM mcp_calls WHERE session_id=? AND attempt_id=?')
        .get(session, attempt)!;
      if (Number(count.n) >= profile.limits.calls_per_attempt)
        throw new ServiceError('mcp_call_limit', 'MCP call limit reached');
      const call: McpCall = {
        id: randomUUID(),
        session_id: session,
        worker_epoch: epoch,
        attempt_id: attempt,
        tool_call_id: toolCall,
        input_digest: input.fingerprint,
        binding_digest: assigned.view.binding_digest,
        profile_digest: assigned.view.profile_digest,
        assignment_digest: assigned.view.assignment_digest,
        credential_generation: assigned.view.credential_generation,
        server_name: input.value.server,
        tool_name: input.value.tool,
        policy: pin.policy,
        arguments_json: input.encoded,
        operation_id: null,
        state: 'prepared',
        result_artifact: null,
        error: null,
        revision: 1,
        created_at: Date.now(),
      };
      if (pin.policy === 'approval')
        call.operation_id = this.managed.prepareMcpInTransaction(
          session,
          epoch,
          attempt,
          toolCall,
          call.server_name + '/' + call.tool_name,
          input.encoded,
          this.context(call),
        ).operation.id;
      const keys = Object.keys(call);
      this.store.db
        .prepare(
          `INSERT INTO mcp_calls(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        )
        .run(...Object.values(call));
      this.store.event(session, 'mcp.prepared', {
        call_id: call.id,
        attempt_id: attempt,
        operation_id: call.operation_id,
        input_digest: call.input_digest,
        assignment_digest: call.assignment_digest,
        server: call.server_name,
        tool: call.tool_name,
        policy: call.policy,
      });
      return this.get(call.id);
    });
  }
  start(id: string, session: string, epoch: number, attempt: string): McpCall {
    const call = this.get(id);
    if (call.session_id !== session || call.worker_epoch !== epoch || call.attempt_id !== attempt)
      throw new ServiceError('mcp_call_scope', 'MCP call belongs to another invocation');
    if (call.state !== 'prepared' || this.active.has(id)) return call;
    if (call.operation_id) {
      const op = this.managed.operation(call.operation_id),
        approval = this.managed.forOperation(op.id);
      if (op.state !== 'prepared') {
        this.store.transaction(() =>
          this.change(
            call,
            op.state === 'outcome_unknown' ? 'outcome_unknown' : 'cancelled_before_dispatch',
            'mcp_permission_unavailable',
          ),
        );
        return this.get(id);
      }
      if (approval.state !== 'decided' || approval.decision !== 'approve') return call;
    }
    const active: Active = {
      session,
      attempt,
      controller: new AbortController(),
      secrets: [],
      done: Promise.resolve(),
    };
    this.active.set(id, active);
    active.done = this.dispatch(id, active)
      .catch((error) => this.fail(session, error as Error))
      .finally(() => this.active.delete(id));
    return this.get(id);
  }
  private async dispatch(id: string, active: Active): Promise<void> {
    try {
      const call = this.get(id);
      const assigned = this.bound(call),
        profile = this.options.admission.profile(),
        pin = profile.servers.find((s) => s.name === call.server_name);
      if (!pin || this.store.hasUnknown(call.session_id))
        throw new ServiceError('operation_blocked', 'MCP execution is not available');
      active.controller.signal.throwIfAborted();
      const server = assigned.assignment.servers.find((s) => s.name === pin.name)!;
      active.secrets = assigned.assignment.servers.flatMap((s) => s.headers.map((h) => h.value));
      const client =
        this.options.connection?.(server, pin, profile.limits) ??
        new ManagedHttpMcp(server, pin, profile.limits);
      active.client = client;
      await client.connect();
      active.invoking = true;
      let traceparent: string | undefined;
      try {
        traceparent =
          workTraceHeader(this.store, call.session_id, 'managed-http:' + call.id) ?? undefined;
      } catch {
        /* Missing/corrupt telemetry is independent of work and usage truth. */
      }
      const raw = await client.call(
        call.tool_name,
        JSON.parse(call.arguments_json),
        active.controller.signal,
        () => {
          this.store.transaction(() => {
            const current = this.get(id);
            if (current.state !== 'prepared')
              throw new ServiceError('mcp_call_stopped', 'MCP call is no longer prepared');
            this.bound(current);
            if (this.store.hasUnknown(current.session_id))
              throw new ServiceError('operation_blocked', 'Unresolved effects block MCP dispatch');
            if (
              current.operation_id &&
              !this.managed.takePermissionInTransaction(current.operation_id)
            )
              throw new ServiceError(
                'mcp_permission_unavailable',
                'MCP permission cannot be consumed',
              );
            this.change(current, 'dispatching');
          });
        },
        traceparent,
      );
      const result = redactMcpData(raw, active.secrets) as McpReturnedResult;
      const artifact = this.artifacts.prepare(call.session_id, canonical(result));
      this.store.transaction(() => {
        const current = this.get(id);
        if (current.state === 'prepared')
          throw new ServiceError(
            'mcp_missing_dispatch',
            'MCP result arrived without a durable dispatch',
          );
        artifact.commit();
        if (current.operation_id)
          this.managed.permissionResultInTransaction(current.operation_id, !result.is_error, {
            protocol_result: result.protocol_result,
            result_artifact: artifact.id,
            external_effect: 'unverified',
          });
        const state =
          current.state === 'dispatching'
            ? current.policy === 'approval'
              ? 'outcome_unknown'
              : result.is_error
                ? 'tool_error'
                : 'returned'
            : current.state;
        this.change(
          current,
          state,
          state === 'outcome_unknown' ? 'mcp_effect_unverified' : current.error,
          artifact.id,
        );
      });
      if (this.get(id).state === 'outcome_unknown')
        this.fail(
          call.session_id,
          new ServiceError('mcp_effect_unverified', 'MCP mutation requires effect reconciliation'),
        );
    } catch (error) {
      const call = this.get(id);
      if (pending(call.state)) {
        this.store.transaction(() => {
          const current = this.get(id);
          if (current.operation_id) {
            const possible =
              current.state === 'dispatching' ||
              (active.invoking &&
                (!(error instanceof McpHttpFailure || error instanceof McpInputFailure) ||
                  error.sent));
            if (possible) this.managed.mcpUnknownInTransaction(current.operation_id);
            else this.managed.mcpNotSentInTransaction(current.operation_id);
          }
          const unknown =
            current.operation_id &&
            this.managed.operation(current.operation_id).state === 'outcome_unknown';
          this.change(
            current,
            unknown ? 'outcome_unknown' : 'failed_definite',
            error instanceof McpInputFailure ? error.code : 'mcp_call_failed',
          );
        });
      }
      const deliberatelyStopped =
        active.controller.signal.aborted &&
        ['interrupted', 'cancelled_before_dispatch'].includes(this.get(id).state);
      if (!(error instanceof McpInputFailure) && !deliberatelyStopped)
        this.fail(
          call.session_id,
          error instanceof McpHttpFailure
            ? error
            : new ServiceError('mcp_control_failed', 'Required MCP execution control failed'),
        );
    } finally {
      active.closing ??= active.client && this.closeClient(active.session, active.client);
      await active.closing;
    }
  }
  private fail(session: string, error: Error): void {
    this.fatal.add(session);
    const safe =
      error instanceof McpHttpFailure
        ? error
        : new ServiceError('mcp_control_failed', 'Required MCP execution control failed');
    try {
      this.options.failed(session, safe);
    } catch {
      /* This controller remains fenced. */
    }
  }
  cancelInTransaction(attempt: string, reason = 'mcp_cancelled'): void {
    if (!this.store.db.isTransaction) throw Error('MCP cancellation requires a transaction');
    for (const row of this.store.db
      .prepare(
        "SELECT id FROM mcp_calls WHERE attempt_id=? AND state IN ('prepared','dispatching')",
      )
      .all(attempt)) {
      const call = this.get(String(row.id));
      if (call.operation_id) this.managed.mcpNotSentInTransaction(call.operation_id);
      this.change(
        call,
        call.state === 'prepared'
          ? 'cancelled_before_dispatch'
          : call.policy === 'approval'
            ? 'outcome_unknown'
            : 'interrupted',
        reason,
      );
    }
  }
  private abort(active: Active): void {
    active.controller.abort();
    active.closing ??= active.client && this.closeClient(active.session, active.client);
    active.closing?.catch((error) => this.fail(active.session, error as Error));
  }
  abortAttempt(attempt: string): void {
    for (const active of this.active.values()) if (active.attempt === attempt) this.abort(active);
  }
  recover(): void {
    if (this.active.size) throw new ServiceError('mcp_busy', 'Cannot recover live MCP calls');
    this.store.transaction(() => {
      for (const row of this.store.db
        .prepare("SELECT id FROM mcp_calls WHERE state IN ('prepared','dispatching')")
        .all()) {
        const call = this.get(String(row.id));
        if (call.operation_id) this.managed.mcpNotSentInTransaction(call.operation_id);
        const unknown =
          call.policy === 'approval' &&
          (call.state === 'dispatching' ||
            this.managed.operation(call.operation_id!).state === 'outcome_unknown');
        this.change(
          call,
          unknown
            ? 'outcome_unknown'
            : call.state === 'prepared'
              ? 'cancelled_before_dispatch'
              : 'interrupted',
          'mcp_recovered_without_replay',
        );
      }
    });
  }
  status(session: string) {
    const row = this.store.db
      .prepare('SELECT view FROM mcp_assignments WHERE session_id=?')
      .get(session);
    return {
      assignment: row ? (JSON.parse(String(row.view)) as View) : null,
      active_calls: [...this.active.entries()]
        .filter(([, a]) => a.session === session)
        .map(([id]) => id),
      local_resources_stopped: this.stopped(session),
      control_error: this.fatal.has(session) ? 'mcp_control_failed' : null,
    };
  }
  private async closeClient(session: string, client: McpConnection): Promise<void> {
    try {
      await client.close();
    } catch {
      this.stopFailures.add(session);
      const error = new ServiceError(
        'mcp_stop_unconfirmed',
        'MCP local transport cleanup could not be confirmed',
      );
      this.fail(session, error);
      throw error;
    }
  }
  stopped(session: string): boolean {
    return (
      !this.stopFailures.has(session) &&
      !this.readiness.has(session) &&
      ![...this.active.values()].some((a) => a.session === session)
    );
  }
  async stopSession(session: string): Promise<void> {
    const readiness = this.readiness.get(session);
    await Promise.allSettled(
      [...(readiness?.clients ?? [])].map((client) => this.closeClient(session, client)),
    );
    const active = [...this.active.values()].filter((a) => a.session === session);
    for (const call of active) this.abort(call);
    await Promise.allSettled([
      ...active.map((a) => a.done),
      ...(readiness ? [readiness.done] : []),
    ]);
    if (!this.stopped(session))
      throw new ServiceError('mcp_stop_unconfirmed', 'MCP local resources have not stopped');
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [session, readiness] of this.readiness)
      await Promise.allSettled(
        [...readiness.clients].map((client) => this.closeClient(session, client)),
      );
    await Promise.allSettled([...this.readiness.values()].map((job) => job.done));
    for (const active of this.active.values()) this.abort(active);
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
    if (this.stopFailures.size)
      throw new ServiceError('mcp_stop_unconfirmed', 'MCP cleanup requires reconciliation');
    this.unregisterOwner();
  }
}
