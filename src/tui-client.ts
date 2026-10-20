import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Outbox, acquireControl, subscribe, type Feed } from './attach.js';
import { call } from './transport.js';
import {
  ServiceError,
  type Session,
  type SessionSnapshot,
  type ControlLease,
  type Approval,
  type Operation,
  type DurableEvent,
} from './protocol.js';
import type { CommandRun } from './coding.js';
import type { Workspace } from './workspaces.js';

export interface OperatorHealth {
  service: string;
  provider_route: { provider: string; model: string; max_tokens: number };
  provider_capabilities?: {
    output_token_cap: boolean;
    durable_tasks: boolean;
    warning: string | null;
  };
  local_workspace?: {
    inspection: boolean;
    session_routes: boolean;
    coding?: boolean;
    reasoning?: boolean;
  };
  coding_root?: string | null;
  execution?: { commands?: boolean; available: boolean; backend?: Record<string, unknown> };
}
export interface WorkspaceView extends Workspace {
  observed_digest: string | null;
  locked_by: string | null;
}
export interface UsageView {
  observations: number;
  unknown_observations: number;
  estimated_observations: number;
  known_input: number;
  known_output: number;
  known_cost: number;
  estimated_cost: number;
}
export interface ToolActivity {
  seq: number;
  kind: string;
  payload: {
    attempt_id: string;
    tool_call_id: string;
    parent_tool_call_id?: string;
    tool: string;
    input?: string;
    input_truncated?: boolean;
    failed?: boolean;
  };
}
export interface LivePreview {
  session_id: string;
  attempt_id: string;
  text: string;
}
export type OperatorConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline';
/** An operator client only: the service owns workers, authority and durable outcomes. */
export class OperatorClient extends EventEmitter {
  readonly socket: string;
  readonly clientId = randomUUID();
  health?: OperatorHealth;
  sessions: Session[] = [];
  names: Record<string, string> = {};
  snapshot?: SessionSnapshot;
  workspace?: WorkspaceView;
  commands: CommandRun[] = [];
  activity: ToolActivity[] = [];
  usage?: UsageView;
  facts: { id: string; kind: string; text: string }[] = [];
  preview?: { attempt_id: string; text: string; truncated: boolean };
  connection: OperatorConnection = 'connecting';
  notice = '';
  private lease?: ControlLease;
  private outbox?: Outbox;
  private generation = 0;
  private feed?: Feed;
  private watcher?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private refreshJob?: Promise<void>;
  private refreshAgain = false;
  private delivery = Promise.resolve();
  private stopped = false;
  constructor(
    readonly state: string,
    socket?: string,
  ) {
    super();
    this.socket = socket ?? join(state, 'operator.sock');
  }
  get controlling(): boolean {
    return !!this.lease;
  }
  get pendingInputs(): number {
    return this.outbox?.records().length ?? 0;
  }
  private changed(): void {
    this.emit('change');
  }
  report(error: unknown): void {
    this.notice = error instanceof Error ? error.message : String(error);
    this.changed();
  }
  async list(): Promise<void> {
    try {
      const [health, sessions] = await Promise.all([
        call<OperatorHealth>(this.socket, '/v1/health'),
        call<Session[]>(this.socket, '/v1/sessions'),
      ]);
      this.health = health;
      this.sessions = sessions;
      const names = await Promise.all(
        sessions.map(async (session) => {
          const result = await call<{ name: string | null }>(
            this.socket,
            `/v1/sessions/${session.id}/name`,
          ).catch(() => ({ name: null }));
          return [session.id, result.name] as const;
        }),
      );
      this.names = Object.fromEntries(
        names.filter((pair): pair is readonly [string, string] => pair[1] !== null),
      );
      this.connection = 'connected';
    } catch (error) {
      this.connection = 'offline';
      this.report(error);
    }
    this.changed();
  }
  async permissions(): Promise<{
    policy: import('./autonomy.js').PermissionPolicy;
    configurable: boolean;
    coding: boolean;
    command_auto_approval: false;
  }> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    return call(this.socket, `/v1/sessions/${this.snapshot.id}/permissions`);
  }
  async setPermissions(
    session: string,
    expected: number,
    policy: { mode: import('./autonomy.js').PermissionMode; paths: string[] },
  ): Promise<void> {
    if (this.snapshot?.id !== session)
      throw new Error('Session changed; review permissions again.');
    await call(this.socket, `/v1/sessions/${session}/permissions`, {
      ...this.actor(),
      request_id: randomUUID(),
      expected_revision: expected,
      policy,
    });
    this.report(
      'Permissions updated. Progression is unchanged; already-running commands are not stopped by this setting.',
    );
    await this.refresh();
  }
  async steer(text: string): Promise<void> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    const result = await call<{ state: string }>(
      this.socket,
      `/v1/sessions/${this.snapshot.id}/steer`,
      { ...this.actor(), request_id: randomUUID(), text },
    );
    this.report(
      result.state === 'received'
        ? 'Worker received steering. This is not a completed-work receipt.'
        : 'Steering delivery is uncertain; inspect history before sending it again.',
    );
  }
  async reconcileUndo(): Promise<void> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    const result = await call<{ state: string }>(
      this.socket,
      `/v1/sessions/${this.snapshot.id}/undo-reconcile`,
      this.actor(),
    );
    this.report(
      result.state === 'completed'
        ? 'Restored files verified; undo reconciliation completed.'
        : 'No undo needs reconciliation.',
    );
    await this.refresh();
  }
  async undoReview(): Promise<import('./local-undo.js').UndoReview> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    return call(this.socket, `/v1/sessions/${this.snapshot.id}/undo`);
  }
  async undo(review: import('./local-undo.js').UndoReview): Promise<void> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    const result = await call<{ state: string }>(
      this.socket,
      `/v1/sessions/${this.snapshot.id}/undo`,
      { ...this.actor(), request_id: randomUUID(), review_digest: review.digest },
    );
    if (result.state !== 'completed')
      throw new Error('Undo outcome is uncertain; inspect files before continuing.');
    await this.refresh();
    this.report('Reverted the reviewed local edit. Conversation history is preserved.');
  }
  async fork(): Promise<void> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    const session = await call<Session>(this.socket, `/v1/sessions/${this.snapshot.id}/fork`, {
      ...this.actor(),
      request_id: randomUUID(),
      expected_revision: this.snapshot.revision,
    });
    await this.open(session.id);
  }
  async name(name: string): Promise<void> {
    if (!this.snapshot) throw new Error('Choose a session first.');
    await call(this.socket, `/v1/sessions/${this.snapshot.id}/name`, {
      ...this.actor(),
      request_id: randomUUID(),
      name,
    });
    this.names[this.snapshot.id] = name;
    await this.refresh();
  }
  async compact(): Promise<void> {
    const id = this.snapshot?.id;
    if (!id) throw new Error('Choose a session first.');
    const state = await call<{ version: number }>(this.socket, `/v1/sessions/${id}/task`);
    await call(this.socket, `/v1/sessions/${id}/compact`, {
      ...this.actor(),
      request_id: randomUUID(),
      expected_version: state.version,
    });
    await this.refresh();
  }
  async create(
    cwd: string,
    coding: boolean,
    route?: import('./provider-config.js').ProviderRoute,
    localCoding = false,
  ): Promise<string> {
    if (!coding) {
      const health = await call<OperatorHealth>(this.socket, '/v1/health');
      if (route?.reasoning !== undefined && !health.local_workspace?.reasoning)
        throw new Error('Restart the daemon to load reasoning selection support.');
      if (localCoding && !health.local_workspace?.coding)
        throw new Error('Restart the daemon to load local coding support.');
      if (!health.local_workspace?.inspection || !health.local_workspace.session_routes)
        throw new Error(
          'This daemon predates local workspace support. Finish its active work, then run sal service stop and reopen sal.',
        );
    }
    const session = await call<Session>(this.socket, '/v1/sessions', {
      request_id: randomUUID(),
      cwd,
      coding,
      ...(!coding
        ? {
            local_workspace: true,
            ...(localCoding ? { local_coding: true } : {}),
            ...(route
              ? {
                  route:
                    route.provider === 'salaam-proof'
                      ? { provider: 'offline' }
                      : {
                          provider: route.provider,
                          model: route.model,
                          ...(route.reasoning !== undefined ? { reasoning: route.reasoning } : {}),
                        },
                }
              : {}),
          }
        : {}),
    });
    await this.open(session.id);
    return session.id;
  }
  async open(id: string, options: { observe?: boolean; takeover?: boolean } = {}): Promise<void> {
    await this.leave();
    const generation = this.generation;
    this.stopped = false;
    this.connection = 'connecting';
    this.notice = '';
    this.changed();
    this.snapshot = await call<SessionSnapshot>(this.socket, `/v1/sessions/${id}/snapshot`);
    if (!options.observe) {
      try {
        this.lease = await acquireControl(this.socket, id, this.clientId, options.takeover);
      } catch (error) {
        if (
          !(error instanceof ServiceError) ||
          !['control_conflict', 'control_required'].includes(error.code)
        )
          throw error;
        this.notice =
          'Another client has control. You are observing; use Take control to take over.';
      }
    }
    if (this.lease) await call(this.socket, `/v1/sessions/${id}/resume`, this.actor());
    this.outbox = new Outbox(this.state, id);
    await this.refresh();
    if (generation !== this.generation) return;
    await this.flush().catch((error) => this.report(error));
    this.timer = setInterval(() => {
      void this.tick(generation).catch((error) => this.report(error));
    }, 5000);
    this.watcher = this.watch(id, generation);
    this.changed();
  }
  private actor(): { client_id: string; token: string } {
    if (!this.lease) throw new Error('Take control before sending an instruction.');
    return { client_id: this.clientId, token: this.lease.token };
  }
  private async tick(generation: number): Promise<void> {
    if (generation !== this.generation || !this.snapshot) return;
    if (this.lease) {
      const lease = this.lease;
      try {
        const renewed = await call<ControlLease>(
          this.socket,
          `/v1/sessions/${this.snapshot.id}/control`,
          {
            ...this.actor(),
            request_id: randomUUID(),
            action: 'renew',
            expected_epoch: lease.epoch,
          },
        );
        if (generation === this.generation && this.lease === lease) this.lease = renewed;
      } catch (error) {
        if (
          error instanceof ServiceError &&
          ['control_required', 'control_conflict'].includes(error.code)
        ) {
          this.lease = undefined;
          this.notice = 'Control moved to another client. You are observing.';
        }
      }
    }
    if (generation !== this.generation) return;
    await this.refresh();
    if (generation !== this.generation) return;
    await this.flush();
  }
  private async flush(): Promise<void> {
    const box = this.outbox,
      session = this.snapshot?.id,
      actor = this.lease ? this.actor() : undefined;
    if (!box || !session) return;
    const job = this.delivery.catch(() => {}).then(() => box.flush(this.socket, session, actor));
    this.delivery = job;
    await job;
    this.changed();
  }
  async submit(text: string, continues?: string): Promise<string> {
    this.actor();
    if (!this.snapshot || !this.outbox) throw new Error('Open a session first.');
    const record = this.outbox.enqueue(text, this.snapshot.revision, continues);
    this.notice = 'Instruction saved locally. Delivering…';
    this.changed();
    try {
      await this.flush();
      this.notice = 'Instruction accepted.';
    } catch (error) {
      if (!this.outbox.records().some((pending) => pending.request_id === record.request_id))
        throw error;
      this.notice =
        'Delivery pending. The saved instruction will be retried: ' + (error as Error).message;
    }
    await this.refresh().catch(() => {});
    this.changed();
    return record.request_id;
  }
  async taskAction(
    action: string,
    body: Record<string, unknown>,
    reviewed?: { id: string; revision: number },
  ): Promise<void> {
    this.actor();
    if (!this.snapshot || !this.outbox) throw new Error('Open a session first');
    const task = reviewed ?? this.snapshot.work_task;
    let path = '/v1/tasks';
    if (action !== 'create') {
      if (!task) throw new Error('Create a task first');
      path += `/${task.id}/${action}`;
    }
    this.outbox.enqueueTask(path, {
      ...body,
      expected_revision: action === 'create' ? 0 : task!.revision,
      ...(action === 'create' ? { session_id: this.snapshot.id } : {}),
    });
    await this.flush();
    await this.refresh();
  }
  async jobAction(
    action: 'create' | 'run' | 'cancel',
    body: Record<string, unknown>,
    reviewed?: { id: string; revision: number },
  ): Promise<void> {
    this.actor();
    if (!this.snapshot || !this.outbox) throw new Error('Open a session first');
    const target = reviewed ?? (action === 'create' ? this.snapshot.work_task : this.snapshot.job);
    if (!target)
      throw new Error(action === 'create' ? 'Create a checked task first' : 'Create a job first');
    this.outbox.enqueueJob(action === 'create' ? '/v1/jobs' : `/v1/jobs/${target.id}/${action}`, {
      ...body,
      expected_revision: target.revision,
      ...(action === 'create' ? { task_id: target.id } : {}),
    });
    await this.flush();
    await this.refresh();
  }
  async scheduleAction(
    action: 'create' | 'run' | 'update',
    body: Record<string, unknown>,
    reviewed: { id: string; revision: number },
  ): Promise<void> {
    this.actor();
    if (!this.snapshot || !this.outbox) throw new Error('Open a session first');
    this.outbox.enqueueJob(
      action === 'create' ? '/v1/schedules' : `/v1/schedules/${reviewed.id}/${action}`,
      {
        ...body,
        expected_revision: reviewed.revision,
        ...(action === 'create' ? { task_id: reviewed.id } : {}),
      },
    );
    await this.flush();
    await this.refresh();
  }
  async resume(): Promise<void> {
    if (!this.snapshot) return;
    await call(this.socket, `/v1/sessions/${this.snapshot.id}/resume`, this.actor());
    await this.refresh();
    await this.flush();
  }
  async takeControl(): Promise<void> {
    if (!this.snapshot) return;
    const id = this.snapshot.id;
    this.lease = await acquireControl(this.socket, id, this.clientId, true);
    await call(this.socket, `/v1/sessions/${id}/resume`, this.actor());
    this.notice = 'You have control.';
    await this.refresh();
    await this.flush();
  }
  async decide(approval: Approval, decision: 'approve' | 'deny'): Promise<void> {
    if (!this.outbox) throw new Error('Open a session first.');
    this.outbox.enqueueDecision(
      approval.id,
      approval.operation_digest,
      approval.revision,
      decision,
    );
    await this.flush();
    this.notice = decision === 'approve' ? 'Approval recorded.' : 'Denial recorded.';
    await this.refresh();
  }
  async review(approval: Approval): Promise<{ approval: Approval; operation: Operation }> {
    const [current, operation] = await Promise.all([
      call<Approval>(this.socket, `/v1/approvals/${approval.id}`),
      call<Operation>(this.socket, `/v1/operations/${approval.operation_id}`),
    ]);
    if (
      current.operation_digest !== approval.operation_digest ||
      current.revision !== approval.revision ||
      current.state !== 'pending'
    )
      throw new Error('This approval changed. Review its current binding again.');
    return { approval: current, operation };
  }
  async cancel(attempt: string): Promise<void> {
    this.actor();
    if (!this.snapshot || !this.outbox) return;
    this.outbox.enqueueCancellation(attempt, this.snapshot.revision);
    await this.flush();
    await this.refresh();
  }
  async cancelCommand(run: string): Promise<void> {
    if (!this.snapshot) return;
    await call(this.socket, `/v1/sessions/${this.snapshot.id}/commands/${run}/cancel`, {
      ...this.actor(),
      request_id: randomUUID(),
    });
    await this.refresh();
  }
  async commandLogs(
    run: string,
    offset: number,
  ): Promise<{ data: string; text: string; next_offset: number; complete: boolean }> {
    if (!this.snapshot) throw new Error('Open a session first.');
    return call(
      this.socket,
      `/v1/sessions/${this.snapshot.id}/commands/${run}/logs?offset=${offset}`,
    );
  }
  async ackInbox(id: string, revision: number): Promise<void> {
    if (!this.snapshot || !this.lease)
      throw new Error('Take control before acknowledging attention');
    await call(this.socket, `/v1/inbox/${id}/ack`, {
      request_id: randomUUID(),
      expected_revision: revision,
      client_id: this.clientId,
      token: this.lease.token,
    });
    await this.refresh();
  }
  async shutdown(): Promise<void> {
    await call(this.socket, '/v1/shutdown', {});
  }
  refresh(): Promise<void> {
    if (this.refreshJob) {
      this.refreshAgain = true;
      return this.refreshJob;
    }
    const generation = this.generation;
    const job = (async () => {
      do {
        this.refreshAgain = false;
        const id = this.snapshot?.id;
        if (!id) {
          await this.list();
          return;
        }
        const optional = async <T>(path: string): Promise<T | undefined> => {
          try {
            return await call<T>(this.socket, path);
          } catch (error) {
            if (
              error instanceof ServiceError &&
              ['not_found', 'coding_disabled', 'workspace_unavailable'].includes(error.code)
            )
              return undefined;
            throw error;
          }
        };
        const [snapshot, health, commands, workspace, usage, task, activity] = await Promise.all([
          call<SessionSnapshot>(this.socket, `/v1/sessions/${id}/snapshot`),
          call<OperatorHealth>(this.socket, '/v1/health'),
          optional<CommandRun[]>(`/v1/sessions/${id}/commands?summary=1`),
          optional<WorkspaceView>(`/v1/sessions/${id}/workspace`),
          call<UsageView>(this.socket, `/v1/sessions/${id}/usage`),
          call<{ facts: { id: string; kind: string; text: string }[] }>(
            this.socket,
            `/v1/sessions/${id}/task`,
          ),
          optional<ToolActivity[]>(`/v1/sessions/${id}/activity`),
        ]);
        if (generation !== this.generation) return;
        this.snapshot = snapshot;
        this.health = health;
        this.commands = commands ?? [];
        this.workspace = workspace;
        this.usage = usage;
        this.facts = task.facts;
        this.activity = activity ?? [];
        this.connection = 'connected';
        if (
          this.preview &&
          !snapshot.attempts.some(
            (attempt) =>
              attempt.id === this.preview!.attempt_id &&
              ['dispatching', 'running'].includes(attempt.state),
          )
        )
          this.preview = undefined;
        if (this.lease && snapshot.control.client_id !== this.clientId) this.lease = undefined;
        this.changed();
      } while (this.refreshAgain && generation === this.generation);
    })()
      .catch((error) => {
        if (generation === this.generation) {
          this.connection = 'reconnecting';
          this.report(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.refreshJob === job) this.refreshJob = undefined;
      });
    this.refreshJob = job;
    return job;
  }
  private async watch(id: string, generation: number): Promise<void> {
    let cursor = this.snapshot?.seq ?? 0;
    while (!this.stopped && generation === this.generation) {
      this.feed = subscribe(
        this.socket,
        id,
        cursor,
        (event: DurableEvent) => {
          if (event.seq <= cursor || generation !== this.generation) return;
          cursor = event.seq;
          if (
            [
              'attempt.completed',
              'attempt.failed',
              'attempt.cancelled',
              'attempt.interrupted',
            ].includes(event.kind)
          )
            this.preview = undefined;
          void this.refresh().catch(() => {});
        },
        (preview: LivePreview) => {
          if (
            generation !== this.generation ||
            preview.session_id !== id ||
            !this.snapshot?.attempts.some(
              (attempt) =>
                attempt.id === preview.attempt_id &&
                ['running', 'dispatching'].includes(attempt.state),
            )
          )
            return;
          const previous = this.preview?.attempt_id === preview.attempt_id ? this.preview.text : '';
          const text = previous + preview.text;
          this.preview = {
            attempt_id: preview.attempt_id,
            text: text.slice(0, 16384),
            truncated: text.length > 16384,
          };
          this.changed();
        },
      );
      try {
        await this.feed.done;
      } catch (error) {
        if (generation === this.generation) this.report(error);
      }
      if (generation !== this.generation || this.stopped) return;
      this.preview = undefined;
      this.connection = 'reconnecting';
      this.changed();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.refresh().catch(() => {});
    }
  }
  async leave(): Promise<void> {
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.feed?.close();
    await this.watcher;
    this.watcher = undefined;
    await this.refreshJob?.catch(() => {});
    await this.delivery.catch(() => {});
    if (this.lease && this.snapshot)
      await call(this.socket, `/v1/sessions/${this.snapshot.id}/control`, {
        ...this.actor(),
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: this.lease.epoch,
      }).catch(() => {});
    this.lease = undefined;
    this.snapshot = undefined;
    this.outbox = undefined;
    this.preview = undefined;
    this.workspace = undefined;
    this.commands = [];
    this.activity = [];
    this.usage = undefined;
    this.facts = [];
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.leave();
  }
}
