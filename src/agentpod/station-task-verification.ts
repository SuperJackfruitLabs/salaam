import { requiredChecks } from '../tasks/policy.js';
import type { Store } from '../store/store.js';
import type { TaskWork } from '../tasks/work.js';
import type { CheckReceipt, WorkTask } from '../core/records.js';
import type { StationWork, StationBinding, StationCall } from './station-work.js';
import type { Artifacts } from '../store/artifacts.js';
import { canonical, digest, ServiceError } from '../core/protocol.js';

interface BoundCheck {
  version: 1;
  check_id: string;
  check_digest: string;
  task_id: string;
  plan_revision: number;
  plan_digest: string;
  station: StationBinding;
  call_id: string;
  call_digest: string;
  tree_digest: string;
}
export interface StationCheckEvidence {
  version: 1;
  backend: 'linux-systemd-station-v1';
  binding_artifact: string;
  check_id: string;
  call_id: string;
  plan_revision: number;
  root_digest: string;
  configuration_digest: string;
  tree_digest: string;
  result_digest: string;
}
/** The task verification members a station check uses. Task verification implements it. */
export interface StationCheckLedger {
  get(id: string): CheckReceipt;
  assertIdle(task: WorkTask, stationInspection?: string): void;
  budget: { check(session: string): void };
}
/** Protected station backend for the existing task_checks/completion controller.
 * It never changes task success. The controller must await withFresh and commit
 * its check/completion state in the synchronous transaction callback, not cache
 * an asynchronous boolean. Durable binding predates native command dispatch. */
export class StationTaskVerification {
  private jobs = new Map<string, Promise<void>>();
  private stopping = false;
  // Serialize the entire observe/revalidate/consume operation. A read endpoint
  // cannot create a competing helper between another check's final validations.
  private observations = new Map<string, Promise<unknown>>();
  private inspections = new Map<string, string>();
  // Process-local ownership is deliberately not reconstructed from durable rows:
  // after failure or restart an unsettled helper still requires recovery.
  observing(id: string, session: string): boolean {
    return this.inspections.get(id) === session;
  }
  private async serialized<T>(session: string, work: () => Promise<T>): Promise<T> {
    const previous = this.observations.get(session);
    const next = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (this.stopping)
          throw new ServiceError('verification_stopped', 'Station verification is stopping');
        return work();
      });
    this.observations.set(session, next);
    try {
      return await next;
    } finally {
      if (this.observations.get(session) === next) this.observations.delete(session);
    }
  }
  private async observe(
    source: string | { task_check_id: string },
    session: string,
    validate: (inspection?: string) => void,
    request?: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const owned = new Set<string>();
    try {
      return await this.station.verificationTree(
        source,
        (id) => {
          owned.add(id);
          this.inspections.set(id, session);
          validate(id);
        },
        request,
      );
    } finally {
      for (const id of owned) this.inspections.delete(id);
    }
  }
  stop(): void {
    this.stopping = true;
  }
  async drain(): Promise<void> {
    await Promise.all([...this.jobs.values()]);
  }
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly verification: StationCheckLedger,
    readonly station: StationWork,
    readonly artifacts: Artifacts,
  ) {
    store.enableStationTaskChecks();
    station.taskCheckGuard = (call) => this.guardOwned(call);
  }
  owns(check: CheckReceipt): boolean {
    return check.engine_id === 'linux-systemd-station-v1';
  }
  binding(task: WorkTask): StationBinding {
    return this.station.ready(task.session_id);
  }
  private guardOwned(call: StationCall): void {
    const check = this.verification.get(call.task_check_id!);
    const task = this.tasks.get(check.task_id);
    if (
      !this.owns(check) ||
      task.session_id !== call.session_id ||
      task.state === 'cancelled' ||
      check.plan_revision !== task.plan_revision ||
      !['accepted', 'running', 'passed'].includes(check.state)
    )
      this.fail();
    if (call.kind === 'check') {
      this.matches(check, task, call);
      if (
        call.id !== digest(['station-task-check-v1', check.id]) ||
        !this.store.db
          .prepare("SELECT 1 FROM requests WHERE actor='station-task-check' AND id=?")
          .get(check.id)
      )
        this.fail();
      this.verification.budget.check(task.session_id);
    }
  }
  private failed(id: string, error: unknown): void {
    const check = this.verification.get(id),
      task = this.tasks.get(check.task_id);
    this.store.taskBudgetDenied?.(task.session_id, error);
    const artifact = this.artifacts.prepare(
      task.session_id,
      canonical({ check_id: id, verified: false, error: (error as Error).message }),
    );
    this.store.transaction(() => {
      artifact.commit();
      this.store.db
        .prepare("UPDATE task_checks SET state='failed',artifact_id=? WHERE id=?")
        .run(artifact.id, id);
      this.store.event(task.session_id, 'work_task.check_failed', {
        task_id: task.id,
        check_id: id,
        artifact_id: artifact.id,
      });
    });
  }
  dispatch(id: string): void {
    if (this.stopping || this.jobs.has(id) || this.verification.get(id).state !== 'accepted')
      return;
    const job = this.serialized(this.tasks.get(this.verification.get(id).task_id).session_id, () =>
      this.dispatchOwned(id),
    )
      .catch((e) => {
        if (this.stopping && e instanceof ServiceError && e.code === 'verification_stopped') return;
        this.failed(id, e);
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
  }
  private async dispatchOwned(id: string): Promise<void> {
    const receipt = this.verification.get(id),
      task = this.tasks.get(receipt.task_id);
    const configured = requiredChecks(task).find((c) => c.key === receipt.check_key);
    if (!configured || configured.cwd !== '.') this.fail();
    const binding = this.station.ready(task.session_id);
    const validate = (inspection?: string) => {
      const current = this.tasks.get(task.id),
        check = this.verification.get(id);
      this.verification.budget.check(current.session_id);
      this.station.assertBinding(current.session_id, binding);
      this.verification.assertIdle(current, inspection);
      if (
        check.state !== 'accepted' ||
        current.state === 'cancelled' ||
        current.plan_revision !== receipt.plan_revision ||
        this.plan(current) !== this.plan(task)
      )
        this.fail();
    };
    validate();
    const observed = await this.observe({ task_check_id: id }, task.session_id, validate);
    let call: string = '';
    this.store.transaction(() => {
      validate();
      this.store.db
        .prepare('UPDATE task_checks SET workspace_digest=? WHERE id=?')
        .run(observed.tree_digest, id);
      const prepared = this.station.prepareTaskCheck(
        id,
        configured!.command,
        String(observed.tree_digest),
      );
      this.bind(id, prepared.id);
      call = prepared.id;
      this.store.db.prepare("UPDATE task_checks SET state='running' WHERE id=?").run(id);
      this.store.event(task.session_id, 'work_task.check_dispatched', {
        task_id: task.id,
        check_id: id,
        station_call_id: call,
      });
    });
    this.station.run(call);
  }
  async reconcile(): Promise<void> {
    for (const r of this.store.db
      .prepare(
        "SELECT id FROM task_checks WHERE engine_id='linux-systemd-station-v1' AND state IN ('accepted','running')",
      )
      .all()) {
      const id = String(r.id),
        check = this.verification.get(id);
      if (this.station.authority.awaitingRenewal?.(this.tasks.get(check.task_id).session_id))
        continue;
      if (check.state === 'accepted') {
        this.dispatch(id);
        continue;
      }
      if (this.jobs.has(id)) continue;
      const saved = this.store.db
        .prepare("SELECT response FROM requests WHERE actor='station-task-check' AND id=?")
        .get(id);
      try {
        if (!saved) this.fail();
        const binding = JSON.parse(
          this.artifacts.read(JSON.parse(String(saved.response))),
        ) as BoundCheck;
        const call = this.station.get(binding.call_id);
        if (['prepared', 'dispatching'].includes(call.state)) continue;
        if (call.state !== 'returned') this.fail();
        await this.withFresh(id, (evidence) => {
          const artifact = this.artifacts.prepare(call.session_id, canonical(evidence));
          artifact.commit();
          this.store.db
            .prepare(
              "UPDATE task_checks SET state='passed',artifact_id=? WHERE id=? AND state='running'",
            )
            .run(artifact.id, id);
          this.store.event(call.session_id, 'work_task.check_passed', {
            task_id: check.task_id,
            check_id: id,
            artifact_id: artifact.id,
          });
        });
      } catch (error) {
        // Concurrent observation or unsettled resource is not a failed command.
        // Keep it running and unverified until reconciliation proves closure.
        if (error instanceof ServiceError && ['task_busy', 'task_uncertain'].includes(error.code))
          continue;
        this.failed(id, error);
      }
    }
  }

  private fail(): never {
    throw new ServiceError(
      'verification_required',
      'Fresh bound protected station evidence required',
    );
  }
  private plan(task: WorkTask): string {
    return digest({
      objective: task.objective,
      constraints: task.constraints,
      acceptance: task.acceptance,
      ...(task.completion_gate ? { completion_gate: task.completion_gate } : {}),
      deliverables: task.deliverables,
      limits: task.limits,
      steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
        key,
        title,
        instruction,
        depends_on,
        checks,
      })),
    });
  }
  private call(call: StationCall): string {
    return digest({
      id: call.id,
      session: call.session_id,
      epoch: call.worker_epoch,
      attempt: call.attempt_id,
      tool: call.tool_call_id,
      kind: call.kind,
      input: call.input_digest,
      root: call.root_digest,
      configuration: call.configuration_digest,
      args: call.args_json,
    });
  }
  private check(check: CheckReceipt): string {
    return digest({
      id: check.id,
      task: check.task_id,
      key: check.check_key,
      step: check.step_id,
      plan_revision: check.plan_revision,
    });
  }
  private matches(check: CheckReceipt, task: WorkTask, call: StationCall): void {
    const configured = requiredChecks(task).find((c) => c.key === check.check_key);
    const args = JSON.parse(call.args_json);
    if (
      check.task_id !== task.id ||
      check.plan_revision !== task.plan_revision ||
      task.state === 'cancelled' ||
      !configured ||
      configured.cwd !== '.' ||
      call.kind !== 'check' ||
      call.session_id !== task.session_id ||
      args.action !== 'check' ||
      args.command !== configured.command ||
      Object.keys(args).sort().join(',') !== 'action,command,expected_tree' ||
      typeof args.expected_tree !== 'string' ||
      !/^[a-f0-9]{64}$/.test(args.expected_tree) ||
      digest(args) !== call.input_digest ||
      (check.step_id !== null &&
        !task.steps.some((s) => s.id === check.step_id && s.checks?.includes(check.check_key)))
    )
      this.fail();
  }
  bind(checkID: string, callID: string): string {
    const check = this.verification.get(checkID),
      task = this.tasks.get(check.task_id);
    // Even saved binding access stays rooted in this authority; no grant on replay.
    this.station.authority.bySession(task.session_id);
    const request = this.store.db.isTransaction
      ? this.store.requestInTransaction.bind(this.store)
      : this.store.request.bind(this.store);
    return request<string>('station-task-check', checkID, { checkID, callID }, () => {
      const current = this.verification.get(checkID),
        latest = this.tasks.get(current.task_id);
      const call = this.station.get(callID),
        station = this.station.ready(latest.session_id);
      this.matches(current, latest, call);
      if (
        current.state !== 'accepted' ||
        call.state !== 'prepared' ||
        call.root_digest !== station.root_digest ||
        call.configuration_digest !== station.configuration_digest
      )
        this.fail();
      const bound: BoundCheck = {
        version: 1,
        check_id: checkID,
        check_digest: this.check(current),
        task_id: latest.id,
        plan_revision: latest.plan_revision,
        plan_digest: this.plan(latest),
        station,
        call_id: callID,
        call_digest: this.call(call),
        tree_digest: JSON.parse(call.args_json).expected_tree,
      };
      const artifact = this.artifacts.prepare(latest.session_id, canonical(bound));
      artifact.commit();
      this.store.event(latest.session_id, 'work_task.station_check_bound', {
        task_id: latest.id,
        check_id: checkID,
        call_id: callID,
        artifact_id: artifact.id,
      });
      return artifact.id;
    });
  }
  private prepared(checkID: string) {
    const original = this.verification.get(checkID),
      task = this.tasks.get(original.task_id);
    this.station.authority.bySession(task.session_id);
    const saved = this.store.db
      .prepare('SELECT response FROM requests WHERE actor=? AND id=?')
      .get('station-task-check', checkID);
    if (!saved) this.fail();
    const artifact = JSON.parse(String(saved.response)) as string;
    const bound = JSON.parse(this.artifacts.read(artifact)) as BoundCheck;
    const validate = (inspection?: string) => {
      const check = this.verification.get(checkID),
        current = this.tasks.get(check.task_id);
      const call = this.station.get(bound.call_id);
      this.matches(check, current, call);
      this.station.assertBinding(current.session_id, bound.station);
      this.verification.assertIdle(current, inspection);
      this.station.assertVerificationSettled(current.session_id, inspection);
      if (
        bound.version !== 1 ||
        bound.check_id !== checkID ||
        bound.check_digest !== this.check(check) ||
        bound.task_id !== current.id ||
        bound.plan_revision !== current.plan_revision ||
        bound.plan_digest !== this.plan(current) ||
        bound.call_digest !== this.call(call) ||
        !['accepted', 'running', 'passed'].includes(check.state) ||
        call.state !== 'returned' ||
        !call.result_json
      )
        this.fail();
      const result = JSON.parse(call.result_json!);
      const unit = this.store.db
        .prepare('SELECT * FROM station_units WHERE call_id=?')
        .get(call.id);
      if (
        !unit ||
        unit.state !== 'stopped' ||
        unit.session_id !== current.session_id ||
        digest(JSON.parse(String(unit.config_json))) !== bound.station.configuration_digest ||
        !unit.unit_json ||
        !unit.stop_json ||
        canonical(result.cleanup) !== canonical(JSON.parse(String(unit.stop_json))) ||
        unit.context_digest !==
          digest({
            id: call.id,
            root: call.root_digest,
            configuration: call.configuration_digest,
            input: call.input_digest,
          }) ||
        result.exit_code !== 0 ||
        result.verified_check !== true ||
        result.expected_tree !== bound.tree_digest ||
        result.observed_tree !== bound.tree_digest ||
        result.network !== 'none' ||
        result.workspace !== 'read-only-reviewed-snapshot'
      )
        this.fail();
      return { current, call, result };
    };
    return { bound, artifact, validate };
  }
  async withFresh<T>(checkID: string, consume: (evidence: StationCheckEvidence) => T): Promise<T> {
    const session = this.tasks.get(this.verification.get(checkID).task_id).session_id;
    return this.serialized(session, () => this.freshOwned(checkID, consume));
  }
  private async freshOwned<T>(
    checkID: string,
    consume: (evidence: StationCheckEvidence) => T,
  ): Promise<T> {
    const { bound, artifact, validate } = this.prepared(checkID);
    const before = validate();
    const revision = before.current.revision;
    const resultDigest = digest(before.result);
    const observed = await this.observe(bound.call_id, before.current.session_id, validate);
    // No await between final authority/plan/resource checks and the consuming write.
    return this.store.transaction(() => {
      const { current, call, result } = validate();
      if (current.revision !== revision || digest(result) !== resultDigest) this.fail();
      if (
        observed.tree_digest !== bound.tree_digest ||
        observed.root_identity !== this.station.config.workspace_identity
      )
        this.fail();
      const value = consume({
        version: 1,
        backend: 'linux-systemd-station-v1',
        binding_artifact: artifact,
        check_id: checkID,
        call_id: call.id,
        plan_revision: bound.plan_revision,
        root_digest: bound.station.root_digest,
        configuration_digest: bound.station.configuration_digest,
        tree_digest: observed.tree_digest,
        result_digest: digest(result),
      });
      this.station.assertBinding(this.tasks.get(bound.task_id).session_id, bound.station);
      if (value && typeof (value as { then?: unknown }).then === 'function')
        throw new ServiceError(
          'verification_required',
          'Verification consumer must commit synchronously',
        );
      return value;
    });
  }
  async withFreshMany<T>(
    ids: string[],
    paths: string[],
    consume: (evidence: StationCheckEvidence[], deliverables: unknown[]) => T,
  ): Promise<T> {
    if (!ids.length) this.fail();
    const session = this.tasks.get(this.verification.get(ids[0]!).task_id).session_id;
    return this.serialized(session, () => this.freshManyOwned(ids, paths, consume));
  }
  private async freshManyOwned<T>(
    ids: string[],
    paths: string[],
    consume: (evidence: StationCheckEvidence[], deliverables: unknown[]) => T,
  ): Promise<T> {
    const prepared = ids.map((id) => this.prepared(id));
    const evidence: StationCheckEvidence[] = [];
    for (const id of ids) evidence.push(await this.freshOwned(id, (e) => e));
    const tree = evidence[0]!.tree_digest,
      root = evidence[0]!.root_digest,
      config = evidence[0]!.configuration_digest;
    if (
      evidence.some(
        (e) =>
          e.tree_digest !== tree || e.root_digest !== root || e.configuration_digest !== config,
      )
    )
      this.fail();
    const revision = prepared[0]!.validate().current.revision;
    const validate = (inspection?: string) => {
      for (let n = 0; n < prepared.length; n++) {
        const state = prepared[n]!.validate(inspection);
        if (
          state.current.revision !== revision ||
          digest(state.result) !== evidence[n]!.result_digest
        )
          this.fail();
      }
    };
    const deliverables: unknown[] = [];
    for (const path of paths) {
      const result = await this.observe(
        evidence[0]!.call_id,
        this.tasks.get(prepared[0]!.bound.task_id).session_id,
        validate,
        {
          action: 'read',
          path,
        },
      );
      validate();
      if (
        result.path !== path ||
        result.tree_digest !== tree ||
        result.root_identity !== this.station.config.workspace_identity
      )
        this.fail();
      // The verified bytes travel with the digest; completion keeps them as an artifact.
      deliverables.push({ path, sha256: result.sha256, content: result.content });
    }
    const final = await this.observe(
      evidence[0]!.call_id,
      this.tasks.get(prepared[0]!.bound.task_id).session_id,
      validate,
    );
    return this.store.transaction(() => {
      validate();
      if (
        final.tree_digest !== tree ||
        final.root_identity !== this.station.config.workspace_identity
      )
        this.fail();
      const result = consume(evidence, deliverables);
      this.station.assertBinding(
        prepared[0]!.validate().current.session_id,
        prepared[0]!.bound.station,
      );
      if (result && typeof (result as { then?: unknown }).then === 'function') this.fail();
      return result;
    });
  }
}
