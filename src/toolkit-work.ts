import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { ManagedWork } from './managed.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import type { ToolkitResources } from './toolkit-resources.js';
import type { ToolkitOwners } from './toolkit-owners.js';
import { ToolkitAdmission } from './toolkit-admission.js';
import { ToolkitCalls, cancelToolkitCalls, type ToolkitCall } from './toolkit-calls.js';
import { ToolkitMcp, type ToolkitCatalogReview } from './toolkit-mcp.js';
import { toolkitRequest } from './toolkit-protocol.js';
import { AGENTPOD_LEASE_MS } from './agentpod-protocol.js';
import { canonical, digest, object, string, ServiceError } from './protocol.js';

export interface ToolkitWorkConfig {
  profile_path: string;
  profile_sha256: string;
  catalog: ToolkitCatalogReview;
}
export interface ToolkitWorkerBinding {
  version: 1;
  binding_digest: string;
  profile_digest: string;
  configuration_digest: string;
  catalog_digest: string;
}
interface Entry {
  client: ToolkitMcp;
  admission: ToolkitAdmission;
  resource: string;
  binding: ToolkitWorkerBinding;
  retiring?: Promise<void>;
}
interface Running {
  session: string;
  attempt: string;
  controller: AbortController;
  done: Promise<void>;
  cancelled?: boolean;
}
function unavailable(): never {
  throw new ServiceError(
    'toolkit_unavailable',
    'Required native Toolkit controller is unavailable',
  );
}

/** Applies a trusted host's reviewed native assignment to actual execution.
 * Models receive only a safe readiness fingerprint; paths, credentials and
 * invocation metadata remain in this daemon. Native callbacks own effect grants. */
export class ToolkitWork {
  readonly calls: ToolkitCalls;
  private readonly config: ToolkitWorkConfig;
  private readonly template: ToolkitAdmission;
  private readonly entries = new Map<string, Entry>();
  private readonly readiness = new Map<string, Promise<ToolkitWorkerBinding>>();
  private readonly active = new Map<string, Running>();
  private readonly fatal = new Set<string>();
  private closing = false;
  get configurationDigest(): string {
    return digest(this.config);
  }
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly authority: AgentPodAuthority,
    readonly resources: ToolkitResources,
    readonly owners: ToolkitOwners,
    config: ToolkitWorkConfig,
    readonly options: {
      assertActive(session: string, epoch: number, attempt: string): void;
      failed(session: string, error: Error): void;
    },
  ) {
    this.config = structuredClone(config);
    if (Object.keys(config).sort().join(',') !== 'catalog,profile_path,profile_sha256')
      unavailable();
    this.template = new ToolkitAdmission(this.config.profile_path, this.config.profile_sha256);
    this.calls = new ToolkitCalls(store, managed, {
      authority,
      resources,
      assertActive: options.assertActive,
      action: (resource, category, action) => {
        const entry = [...this.entries.values()].find((e) => e.resource === resource);
        if (!entry) unavailable();
        return entry.client.pin(category, action);
      },
    });
  }
  private fail(session: string, error: Error): void {
    if (this.closing) return;
    this.fatal.add(session);
    const entry = this.entries.get(session);
    if (entry) this.resources.fence(entry.resource);
    try {
      this.options.failed(session, error);
    } catch {}
  }
  private live(session: string): Entry {
    if (this.closing || this.fatal.has(session)) unavailable();
    const entry = this.entries.get(session);
    if (!entry) unavailable();
    const binding = this.authority.binding(session),
      admitted = entry.admission.launch(binding);
    if (
      entry.binding.binding_digest !== digest(binding) ||
      entry.binding.profile_digest !== admitted.profile_digest ||
      entry.binding.configuration_digest !== digest(this.config)
    )
      unavailable();
    this.resources.assertLive(entry.resource);
    return entry;
  }
  ready(session: string): Promise<ToolkitWorkerBinding> {
    const pending = this.readiness.get(session);
    if (pending) return pending;
    const promise = this.initialize(session)
      .catch((error) => {
        this.fail(session, error as Error);
        throw new ServiceError(
          'toolkit_readiness_failed',
          'Required native Toolkit readiness failed',
        );
      })
      .finally(() => this.readiness.delete(session));
    this.readiness.set(session, promise);
    return promise;
  }
  private async initialize(session: string): Promise<ToolkitWorkerBinding> {
    if (this.closing || this.fatal.has(session) || this.store.hasUnknown(session)) unavailable();
    const previous = this.entries.get(session);
    if (previous?.retiring) await previous.retiring;
    if (previous && this.resources.get(previous.resource).state !== 'stopped')
      return structuredClone(this.live(session).binding);
    if (previous) {
      await previous.client.close();
      this.resources.stopProof(previous.resource);
      this.entries.delete(session);
    }
    if (this.closing || this.fatal.has(session) || this.store.hasUnknown(session)) unavailable();
    const binding = this.authority.binding(session),
      admission = this.template.materialize(binding),
      launch = admission.launch(binding),
      resource = randomUUID(),
      transport = admission.transport(this.resources, session, resource);
    try {
      const client = new ToolkitMcp(transport, this.config.catalog, () =>
          this.fail(session, new Error('Native Toolkit protocol failed')),
        ),
        entry: Entry = {
          client,
          admission,
          resource,
          binding: {
            version: 1,
            binding_digest: digest(binding),
            profile_digest: launch.profile_digest,
            configuration_digest: digest(this.config),
            catalog_digest: this.config.catalog.catalog_digest,
          },
        };
      this.entries.set(session, entry);
      this.owners.register(resource, this.calls, admission);
      await client.connect();
      if (this.entries.get(session) !== entry) unavailable();
      return structuredClone(this.live(session).binding);
    } catch (error) {
      await this.resources.stop(resource);
      throw error;
    }
  }
  assertBinding(session: string, binding: ToolkitWorkerBinding): void {
    if (canonical(this.live(session).binding) !== canonical(binding)) unavailable();
  }
  catalog(
    session: string,
    binding: ToolkitWorkerBinding,
    category?: string,
    action?: string,
  ): unknown {
    this.assertBinding(session, binding);
    return this.live(session).client.catalog(category, action);
  }
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    toolCall: string,
    input: unknown,
  ): ToolkitCall {
    string(toolCall, 'Toolkit tool call', 512);
    const value = object(input),
      category = string(value.category, 'category', 128),
      action = string(value.action, 'action', 128),
      args = object(value.arguments);
    if (Object.keys(value).sort().join(',') !== 'action,arguments,category')
      throw new ServiceError('invalid_mcp_arguments', 'Unexpected native Toolkit call field', 400);
    const saved = this.store.db
      .prepare(
        'SELECT id FROM toolkit_calls WHERE session_id=? AND worker_epoch=? AND tool_call_id=?',
      )
      .get(session, epoch, toolCall);
    if (saved) {
      const call = this.calls.saved(
          String(saved.id),
          JSON.parse(this.authority.bySession(session).binding),
        ),
        request = JSON.parse(call.request_json);
      if (
        call.attempt_id !== attempt ||
        request.service !== category ||
        request.action !== action ||
        canonical(request.args) !== canonical(args)
      )
        throw new ServiceError(
          'request_conflict',
          'Native Toolkit tool call already binds different input',
        );
      return call;
    }
    this.options.assertActive(session, epoch, attempt);
    if (this.store.hasUnknown(session)) unavailable();
    const entry = this.live(session),
      pin = entry.client.pin(category, action),
      duration = this.authority.leaseWindow(
        session,
        entry.binding.binding_digest,
        AGENTPOD_LEASE_MS,
      ),
      request = toolkitRequest({
        version: 1,
        root_digest: entry.binding.binding_digest,
        profile_digest: entry.binding.profile_digest,
        invocation_id: digest({ session, epoch, toolCall }),
        service: category,
        action,
        args,
        approval: pin.policy === 'approval',
        expires_at_ms: Math.min(
          Date.now() + duration,
          this.authority.bySession(session).expires_at,
        ),
      });
    entry.client.validate(request);
    return this.calls.prepare(session, epoch, attempt, toolCall, entry.resource, request);
  }
  start(id: string, session: string, epoch: number, attempt: string): ToolkitCall {
    const call = this.calls.get(id);
    if (call.session_id !== session || call.worker_epoch !== epoch || call.attempt_id !== attempt)
      throw new ServiceError(
        'mcp_call_scope',
        'Native Toolkit call belongs to another invocation',
        403,
      );
    if (!['prepared', 'pending'].includes(call.state) || this.active.has(id)) return call;
    if (toolkitRequest(JSON.parse(call.request_json)).expires_at_ms <= Date.now())
      return this.calls.cancelUndispatched(id);
    if (call.operation_id) {
      this.managed.expire();
      const approval = this.managed.forOperation(call.operation_id),
        op = this.managed.operation(call.operation_id);
      if (approval.state === 'pending') return call;
      if (op.state !== 'prepared' || approval.decision !== 'approve')
        return this.calls.cancelUndispatched(id);
    }
    const running: Running = {
      session,
      attempt,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(id, running);
    running.done = this.dispatch(call, running).finally(() => this.active.delete(id));
    return this.calls.get(id);
  }
  private async dispatch(call: ToolkitCall, running: Running): Promise<void> {
    try {
      const entry = this.live(call.session_id);
      this.options.assertActive(call.session_id, call.worker_epoch, call.attempt_id);
      if (entry.resource !== call.resource_id) unavailable();
      const request = toolkitRequest(JSON.parse(call.request_json));
      entry.client.validate(request);
      running.controller.signal.throwIfAborted();
      this.calls.deliver(call.id);
      const result = await entry.client.invoke(request, running.controller.signal);
      this.calls.record(call.id, entry.resource, result.receipt);
    } catch (error) {
      try {
        this.calls.unknown(call.id);
      } catch {
        this.resources.fence(call.resource_id);
      }
      if (!running.cancelled) this.fail(call.session_id, error as Error);
    }
  }
  view(id: string): unknown {
    const call = this.calls.get(id),
      receipt = call.receipt_json ? JSON.parse(call.receipt_json) : null,
      outcome = receipt?.state === 'returned' ? JSON.parse(receipt.result) : null;
    return {
      call,
      result: outcome
        ? {
            protocol_result: 'returned',
            is_error: !!outcome.is_error || call.state !== 'returned',
            content: [{ type: 'text', text: outcome.body }],
            structured_content: {
              protocol_result: outcome.protocol_result,
              status: outcome.status,
              native_state: receipt.state,
            },
          }
        : null,
      ...(call.operation_id
        ? {
            operation: this.managed.operation(call.operation_id),
            approval: this.managed.forOperation(call.operation_id),
          }
        : {}),
    };
  }
  abortAttempt(attempt: string): void {
    for (const row of this.store.db
      .prepare(
        'SELECT DISTINCT resource_id FROM toolkit_calls WHERE attempt_id=? AND cancel_requested=1',
      )
      .all(attempt)) {
      const entry = [...this.entries.values()].find((e) => e.resource === row.resource_id);
      if (entry)
        void this.retire(entry).catch((error) =>
          this.fail(this.resources.get(entry.resource).session_id, error),
        );
    }
    for (const running of this.active.values())
      if (running.attempt === attempt) {
        running.cancelled = true;
        const entry = this.entries.get(running.session);
        if (entry) void this.retire(entry).catch((error) => this.fail(running.session, error));
        running.controller.abort();
      }
  }
  cancelInTransaction(attempt: string): void {
    cancelToolkitCalls(this.store, this.managed, attempt, this.resources);
  }
  private retire(entry: Entry): Promise<void> {
    return (entry.retiring ??= (async () => {
      await entry.client.close();
      await this.resources.stop(entry.resource);
    })());
  }
  async stopSession(session: string): Promise<void> {
    for (const running of this.active.values())
      if (running.session === session) {
        running.cancelled = true;
        running.controller.abort();
      }
    const entry = this.entries.get(session);
    if (entry) await this.retire(entry);
    await Promise.allSettled(
      [...this.active.values()].filter((a) => a.session === session).map((a) => a.done),
    );
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const running of this.active.values()) running.controller.abort();
    const results = await Promise.allSettled(
      [...this.entries.keys()].map((session) => this.stopSession(session)),
    );
    await Promise.allSettled(this.readiness.values());
    this.calls.close();
    const errors = results.filter((r) => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((e) => e.reason),
        'Native Toolkit shutdown is unconfirmed',
      );
  }
}
