import type { TaskCritic, CriticVerdict } from './critic.js';
import { requiredChecks } from './policy.js';
import {
  StationTaskVerification,
  type StationCheckEvidence,
} from '../agentpod/station-task-verification.js';
import type { StationWork } from '../agentpod/station-work.js';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { TaskWork } from './work.js';
import type { WorkTask, CheckReceipt } from '../core/records.js';
import type { TaskBudget } from './budget.js';
import type { CodingWork } from '../coding/coding.js';
import { commandTerminal } from '../coding/coding.js';
import { readTree, type Workspaces } from '../workers/workspaces.js';
import type { Artifacts } from '../store/artifacts.js';
import { canonical, digest, ServiceError, type Controller } from '../core/protocol.js';

export class TaskVerification {
  station?: StationTaskVerification;
  installStation(station: StationWork): void {
    if (this.station) throw Error('Station verification backend already installed');
    this.station = new StationTaskVerification(
      this.store,
      this.tasks,
      this,
      station,
      this.artifacts,
    );
  }
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly budget: TaskBudget,
    readonly workspaces: Workspaces,
    readonly coding: CodingWork,
    readonly artifacts: Artifacts,
  ) {}
  binding(task: WorkTask): unknown {
    if (this.station) return this.station.binding(task);
    const w = this.workspaces.verify(task.session_id);
    if (!this.coding.executor)
      throw new ServiceError(
        'verification_unavailable',
        'Bounded tasks require a proven workspace executor',
      );
    return {
      workspace_id: w.id,
      workspace_revision: w.revision,
      workspace_digest: w.digest,
      profile_digest: this.coding.executor.profileDigest,
      engine_id: this.coding.executor.engineId,
    };
  }
  assertIdle(task: WorkTask, stationInspection?: string): void {
    if (
      this.budget.active(task, { verification: true }) > 0 ||
      this.store.db
        .prepare("SELECT 1 FROM compactions WHERE session_id=? AND state='running'")
        .get(task.session_id)
    )
      throw new ServiceError(
        'task_busy',
        'Wait for attempts, children, commands and compaction to settle',
      );
    const tree = [
      task.session_id,
      ...(
        this.store.db
          .prepare('SELECT child_session FROM child_tasks WHERE parent_session=?')
          .all(task.session_id) as { child_session: string }[]
      ).map((c) => c.child_session),
    ];
    let observing = false;
    for (const session of tree) {
      const pending = this.store.db
        .prepare(
          "SELECT id,kind,tool_call_id,args_json,state,helper_state FROM station_calls WHERE session_id=? AND NOT(id=? AND kind='read' AND tool_call_id=id AND state='dispatching' AND helper_state IN ('none','launching','running','stopped') AND json_extract(args_json,'$.action') IN ('inspect','read')) AND (state IN ('prepared','dispatching','outcome_unknown') OR helper_state NOT IN ('none','stopped'))",
        )
        .all(session, stationInspection ?? '');
      const uncertain = pending.some((call) => {
        if (
          call.state === 'dispatching' &&
          ['none', 'launching', 'running', 'stopped'].includes(String(call.helper_state)) &&
          call.kind === 'read' &&
          call.tool_call_id === call.id &&
          ['inspect', 'read'].includes(JSON.parse(String(call.args_json)).action) &&
          this.station?.observing(String(call.id), session)
        ) {
          observing = true;
          return false;
        }
        return true;
      });
      if (
        this.store.hasUnknown(session) ||
        uncertain ||
        this.store.db
          .prepare("SELECT 1 FROM station_units WHERE session_id=? AND state!='stopped'")
          .get(session) ||
        this.store.db
          .prepare(
            "SELECT 1 FROM attempts WHERE session_id=? AND state='interrupted' AND resolved_by IS NULL",
          )
          .get(session) ||
        this.store.db
          .prepare("SELECT 1 FROM command_runs WHERE session_id=? AND state='outcome_unknown'")
          .get(session)
      )
        throw new ServiceError(
          'task_uncertain',
          'Resolve interrupted work and uncertain effects before task completion',
        );
    }
    if (observing)
      throw new ServiceError('task_busy', 'Wait for owned verification observations to settle');
  }
  get(id: string): CheckReceipt {
    const r = this.store.db.prepare('SELECT * FROM task_checks WHERE id=?').get(id) as unknown as
      CheckReceipt | undefined;
    if (!r) throw new ServiceError('not_found', 'Task check not found', 404);
    return r;
  }
  list(task: string): CheckReceipt[] {
    return this.store.db
      .prepare('SELECT * FROM task_checks WHERE task_id=? ORDER BY rowid DESC LIMIT 100')
      .all(task) as unknown as CheckReceipt[];
  }
  start(
    id: string,
    key: string,
    step: string | null,
    request: string,
    expected: number,
    authorize: () => void,
  ): CheckReceipt {
    const accepted = this.store.request(
      'local-operator',
      request,
      { kind: 'task-verify', id, key, step, expected },
      () => {
        authorize();
        const task = this.tasks.get(id);
        if (task.revision !== expected)
          throw new ServiceError('task_revision_conflict', 'Task revision changed');
        if (task.state === 'cancelled')
          throw new ServiceError('task_settled', 'Revise a cancelled task before completing it');
        this.assertIdle(task);
        if (!this.station) this.coding.assertSafe(task.session_id);
        if (!requiredChecks(task).some((c) => c.key === key))
          throw new ServiceError('invalid_check', 'Check is not in this task plan');
        if (
          step &&
          !task.steps.some(
            (s) => s.id === step && s.state === 'awaiting_review' && s.checks?.includes(key),
          )
        )
          throw new ServiceError('invalid_check', 'Step does not await this configured check');
        const protectedBinding = this.station?.binding(task);
        const w = protectedBinding
          ? { id: 'station:' + protectedBinding.root_digest, revision: 0, digest: 'pending' }
          : this.workspaces.verify(task.session_id);
        if (step) this.tasks.assertStepReview?.(task.id, step);
        if (!this.station && !this.coding.executor)
          throw new ServiceError('verification_unavailable', 'No proven verification executor');
        this.budget.verification(task);
        const check = randomUUID();
        this.store.db
          .prepare("INSERT INTO task_checks VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'accepted',NULL)")
          .run(
            check,
            id,
            step,
            key,
            task.plan_revision,
            w.id,
            w.revision,
            w.digest,
            protectedBinding?.configuration_digest ?? this.coding.executor!.profileDigest,
            protectedBinding?.runner ?? this.coding.executor!.engineId,
          );
        this.store.db
          .prepare(
            "UPDATE durable_tasks SET state='verifying',reason='Configured verification command accepted',revision=revision+1 WHERE id=?",
          )
          .run(id);
        this.store.event(task.session_id, 'work_task.check_accepted', {
          task_id: id,
          check_id: check,
          check_key: key,
          workspace_digest: w.digest,
        });
        return { id: check };
      },
    );
    this.dispatch(accepted.id);
    return this.get(accepted.id);
  }
  dispatch(id: string): void {
    let receipt = this.get(id);
    if (receipt.state !== 'accepted') return;
    if (receipt.engine_id === 'linux-systemd-station-v1') {
      if (!this.station)
        throw new ServiceError('verification_unavailable', 'Protected station backend unavailable');
      this.station.dispatch(id);
      return;
    }
    const task = this.tasks.get(receipt.task_id),
      check = requiredChecks(task).find((c) => c.key === receipt.check_key);
    try {
      const existing = this.store.db
        .prepare('SELECT id FROM command_runs WHERE session_id=? AND step_key=?')
        .get(task.session_id, 'task-check:' + id) as { id: string } | undefined;
      if (!existing && task.state === 'cancelled')
        throw new ServiceError(
          'task_settled',
          'Task cancelled before verification command admission',
        );
      if (!existing && (task.plan_revision !== receipt.plan_revision || !check))
        throw new ServiceError('check_stale', 'Verification plan changed before dispatch');
      const run = existing
        ? this.coding.get(task.session_id, existing.id)
        : this.coding.start(
            task.session_id,
            null,
            {
              step_key: 'task-check:' + id,
              command: check!.command,
              cwd: check!.cwd,
              expected_revision: receipt.workspace_revision,
            },
            () => {
              this.budget.check(task.session_id);
              const w = this.workspaces.get(task.session_id);
              if (
                w.state !== 'ready' ||
                digest(readTree(w.root)) !== receipt.workspace_digest ||
                w.id !== receipt.workspace_id ||
                w.digest !== receipt.workspace_digest ||
                w.revision !== receipt.workspace_revision ||
                this.coding.executor?.profileDigest !== receipt.profile_digest ||
                this.coding.executor.engineId !== receipt.engine_id
              )
                throw new ServiceError(
                  'check_stale',
                  'Verification workspace or environment changed',
                );
            },
          );
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE task_checks SET command_run_id=?,state='running' WHERE id=? AND state='accepted'",
          )
          .run(run.id, id);
        this.store.event(task.session_id, 'work_task.check_dispatched', {
          task_id: task.id,
          check_id: id,
          run_id: run.id,
        });
      });
    } catch (error) {
      if (
        this.store.db
          .prepare('SELECT 1 FROM command_runs WHERE session_id=? AND step_key=?')
          .get(task.session_id, 'task-check:' + id)
      )
        throw error;
      this.store.taskBudgetDenied?.(task.session_id, error);
      const artifact = this.artifacts.prepare(
        task.session_id,
        canonical({ check_id: id, error: (error as Error).message, command_dispatched: false }),
      );
      this.store.transaction(() => {
        artifact.commit();
        this.store.db
          .prepare("UPDATE task_checks SET state='failed',artifact_id=? WHERE id=?")
          .run(artifact.id, id);
        this.store.event(task.session_id, 'work_task.check_failed', {
          task_id: task.id,
          check_id: id,
          error: (error as Error).message,
        });
      });
    }
  }
  fresh(receipt: CheckReceipt): boolean {
    if (receipt.engine_id === 'linux-systemd-station-v1') return false; // Requires awaited native observation.
    if (receipt.state !== 'passed' || !receipt.artifact_id) return false;
    try {
      const task = this.tasks.get(receipt.task_id),
        w = this.workspaces.verify(task.session_id);
      const artifact = JSON.parse(this.artifacts.read(receipt.artifact_id));
      return (
        task.plan_revision === receipt.plan_revision &&
        w.id === receipt.workspace_id &&
        w.revision === receipt.workspace_revision &&
        w.digest === receipt.workspace_digest &&
        receipt.profile_digest === this.coding.executor?.profileDigest &&
        receipt.engine_id === this.coding.executor?.engineId &&
        artifact.exit_code === 0 &&
        artifact.state === 'succeeded'
      );
    } catch {
      return false;
    }
  }
  reconcile(): void {
    for (const row of this.store.db
      .prepare("SELECT id FROM task_checks WHERE state IN ('accepted','running') ORDER BY rowid")
      .all() as { id: string }[]) {
      let receipt = this.get(row.id);
      if (receipt.engine_id === 'linux-systemd-station-v1') continue;
      if (receipt.state === 'accepted') {
        this.dispatch(receipt.id);
        receipt = this.get(row.id);
      }
      if (receipt.state !== 'running' || !receipt.command_run_id) continue;
      const task = this.tasks.get(receipt.task_id),
        run = this.coding.get(task.session_id, receipt.command_run_id);
      if (!commandTerminal(run.state)) continue;
      let passed = run.state === 'succeeded' && run.exit_code === 0 && !!run.result_artifact;
      let diff: unknown = null;
      try {
        const w = this.workspaces.verify(task.session_id);
        if (
          w.id !== receipt.workspace_id ||
          w.revision !== receipt.workspace_revision ||
          w.digest !== receipt.workspace_digest ||
          task.plan_revision !== receipt.plan_revision
        )
          passed = false;
        if (run.result_artifact) this.artifacts.read(run.result_artifact);
        const current = readTree(w.root),
          baseline = JSON.parse(this.artifacts.read(w.baseline));
        diff = {
          baseline_digest: digest(baseline),
          current_digest: digest(current),
          changes: Object.keys({ ...baseline, ...current })
            .sort()
            .filter((p) => digest(baseline[p] ?? null) !== digest(current[p] ?? null))
            .map((path) => ({
              path,
              before: baseline[path] ?? null,
              after: current[path] ?? null,
            })),
        };
        if (digest(current) !== receipt.workspace_digest) passed = false;
      } catch {
        passed = false;
      }
      const evidence = this.artifacts.prepare(
        task.session_id,
        canonical({
          check_id: receipt.id,
          plan_revision: receipt.plan_revision,
          workspace_id: receipt.workspace_id,
          workspace_revision: receipt.workspace_revision,
          workspace_digest: receipt.workspace_digest,
          diff,
          diff_digest: digest(diff),
          command: run.command,
          cwd: run.cwd,
          environment: this.coding.executor?.evidence ?? null,
          profile_digest: run.profile_digest,
          engine_id: run.engine_id,
          exit_code: run.exit_code,
          state: run.state,
          snapshot_artifact: run.snapshot_artifact,
          result_artifact: run.result_artifact,
          error: run.error,
        }),
      );
      this.store.transaction(() => {
        evidence.commit();
        this.store.db
          .prepare('UPDATE task_checks SET state=?,artifact_id=? WHERE id=?')
          .run(passed ? 'passed' : 'failed', evidence.id, receipt.id);
        this.store.event(task.session_id, 'work_task.check_' + (passed ? 'passed' : 'failed'), {
          task_id: task.id,
          check_id: receipt.id,
          run_id: run.id,
          artifact_id: evidence.id,
        });
      });
    }
  }
  async reconcileAsync(): Promise<void> {
    this.reconcile();
    await this.station?.reconcile();
  }
  async freshAsync(receipt: CheckReceipt): Promise<boolean> {
    if (receipt.engine_id !== 'linux-systemd-station-v1') return this.fresh(receipt);
    if (!this.station || receipt.state !== 'passed' || !receipt.artifact_id) return false;
    try {
      this.artifacts.read(receipt.artifact_id);
      return await this.station.withFresh(receipt.id, () => true);
    } catch {
      return false;
    }
  }
  async verifiedStepAsync(task: WorkTask, stepId: string): Promise<void> {
    if (!this.station) {
      this.verifiedStep(task, stepId);
      return;
    }
    const current = this.tasks.get(task.id),
      step = current.steps.find((s) => s.id === stepId);
    if (step?.state === 'completed') return;
    if (step?.state !== 'awaiting_review' || !step.checks?.length)
      throw new ServiceError('verification_required', 'Step requires configured checks');
    const receipts = step.checks.map((key) => this.latest(current, key, stepId));
    if (receipts.some((r) => !r || r.state !== 'passed'))
      throw new ServiceError('verification_required', 'Fresh step verification required');
    await this.station.withFreshMany(
      receipts.map((r) => r!.id),
      [],
      () => this.verifiedStepRecorded(current, stepId, receipts as CheckReceipt[]),
    );
  }
  latest(task: WorkTask, key: string, step: string | null): CheckReceipt | undefined {
    return this.store.db
      .prepare(
        'SELECT * FROM task_checks WHERE task_id=? AND check_key=? AND step_id IS ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(task.id, key, step) as unknown as CheckReceipt | undefined;
  }
  verifiedStep(task: WorkTask, stepId: string): void {
    this.store.transaction(() => {
      const current = this.tasks.get(task.id),
        step = current.steps.find((s) => s.id === stepId);
      if (step?.state === 'completed') return;
      if (step?.state !== 'awaiting_review' || !step.checks?.length)
        throw new ServiceError('verification_required', 'Step requires configured checks');
      this.tasks.assertStepReview?.(current.id, stepId);
      this.assertIdle(current);
      const receipts = step.checks.map((key) => this.latest(current, key, stepId));
      if (receipts.some((r) => !r || !this.fresh(r)))
        throw new ServiceError('verification_required', 'Fresh step verification required');
      this.verifiedStepRecorded(current, stepId, receipts as CheckReceipt[]);
    });
  }
  private verifiedStepRecorded(current: WorkTask, stepId: string, receipts: CheckReceipt[]): void {
    const task = current;
    this.tasks.assertStepReview?.(current.id, stepId);
    this.assertIdle(current);
    this.store.db
      .prepare("UPDATE task_steps SET state='completed',review=? WHERE id=?")
      .run('Verified by receipts: ' + receipts.map((r) => r!.id).join(', '), stepId);
    this.store.db
      .prepare(
        "UPDATE durable_tasks SET state='verifying',reason='Step verified; bounded progression may continue',revision=revision+1 WHERE id=?",
      )
      .run(task.id);
    this.store.db
      .prepare('UPDATE task_runtime SET auto_binding=? WHERE task_id=?')
      .run(canonical(this.binding(current)), task.id);
    this.store.event(task.session_id, 'work_task.step_verified', {
      task_id: task.id,
      step_id: stepId,
      check_ids: receipts.map((r) => r!.id),
      verified: true,
    });
  }
  finish(
    id: string,
    request: string,
    expected: number,
    exception: { reason: string; evidence_artifact: string } | null,
    authorize: () => void,
  ): WorkTask {
    if (this.station)
      throw new ServiceError(
        'verification_required',
        'Protected station completion requires awaited verification',
      );
    return this.finishRecorded(id, request, expected, exception, authorize);
  }
  /** Item 8: the completion critic, when the service has one. */
  critic?: TaskCritic;
  /** The critic's verdict on the current fresh verified evidence, starting it the first time.
   * Reads the evidence outside the finishing transaction, so starting the reviewer can never be
   * rolled back with a refused finish; the finish itself re-checks the verdict against its own
   * evidence. */
  async criticGateAsync(task: WorkTask): Promise<CriticVerdict> {
    if (!task.completion_gate?.critic) return { state: 'pass' };
    if (!this.critic || !this.station)
      return { state: 'failed', reason: 'A critic needs the station verification boundary' };
    const checks = requiredChecks(task).map((c) => this.latest(task, c.key, null));
    if (checks.some((c) => !c || c.state !== 'passed')) return { state: 'pending' };
    const fresh = await this.station.withFreshMany(
      checks.map((c) => c!.id),
      task.deliverables,
      (evidence, deliverables) => ({ evidence, deliverables }),
    );
    return this.critic.gate(
      task,
      digest(fresh.evidence),
      (fresh.deliverables as { path: string; content: string }[]).map(({ path, content }) => ({
        path,
        content,
      })),
    );
  }
  async finishAsync(
    id: string,
    request: string,
    expected: number,
    exception: { reason: string; evidence_artifact: string } | null,
    authorize: () => void,
  ): Promise<WorkTask> {
    if (!this.station) return this.finish(id, request, expected, exception, authorize);
    const task = this.tasks.get(id);
    this.station.station.authority.bySession(task.session_id);
    if (
      this.store.db
        .prepare("SELECT 1 FROM requests WHERE actor='local-operator' AND id=?")
        .get(request)
    ) {
      this.store.request(
        'local-operator',
        request,
        { kind: 'task-finish', id, expected, exception },
        () => {
          throw Error('Missing saved finish');
        },
      );
      return this.tasks.get(id);
    }
    authorize();
    if (exception)
      throw new ServiceError(
        'verification_required',
        'Strict station work requires verified completion without exceptions',
      );
    if (!task.acceptance.length || !task.deliverables.length)
      throw new ServiceError(
        'verification_required',
        'Configured checks and deliverables required',
      );
    const checks = requiredChecks(task).map((c) => this.latest(task, c.key, null));
    if (checks.some((c) => !c || c.state !== 'passed'))
      throw new ServiceError('verification_required', 'Passed configured checks required');
    return this.station.withFreshMany(
      checks.map((c) => c!.id),
      task.deliverables,
      (evidence, deliverables) =>
        this.finishRecorded(id, request, expected, null, authorize, { evidence, deliverables }),
    );
  }
  async viewAsync(task: WorkTask): Promise<unknown> {
    if (!this.station) return this.view(task);
    const view = this.view(task) as {
      checks: (CheckReceipt & { fresh: boolean })[];
      completion: Record<string, unknown> | null;
    };
    for (const check of view.checks) check.fresh = await this.freshAsync(check);
    if (view.completion?.state === 'succeeded') {
      try {
        const evidence = JSON.parse(this.artifacts.read(String(view.completion.artifact_id)));
        const checks = requiredChecks(task).map((c) => this.latest(task, c.key, null));
        if (checks.some((c) => !c || c.state !== 'passed' || !evidence.checks.includes(c.id)))
          throw Error('Changed checks');
        view.completion.fresh = await this.station.withFreshMany(
          checks.map((c) => c!.id),
          task.deliverables,
          (fresh) =>
            view.completion!.plan_revision === this.tasks.get(task.id).plan_revision &&
            view.completion!.workspace_digest === fresh[0]!.tree_digest,
        );
      } catch {
        view.completion.fresh = false;
      }
    }
    return view;
  }
  private finishRecorded(
    id: string,
    request: string,
    expected: number,
    exception: { reason: string; evidence_artifact: string } | null,
    authorize: () => void,
    protectedResult?: { evidence: StationCheckEvidence[]; deliverables: unknown[] },
  ): WorkTask {
    const record = this.store.db.isTransaction
      ? this.store.requestInTransaction.bind(this.store)
      : this.store.request.bind(this.store);
    record('local-operator', request, { kind: 'task-finish', id, expected, exception }, () => {
      authorize();
      const task = this.tasks.get(id);
      if (task.revision !== expected)
        throw new ServiceError('task_revision_conflict', 'Task revision changed');
      if (task.state === 'cancelled')
        throw new ServiceError('task_settled', 'Revise a cancelled task before completing it');
      this.assertIdle(task);
      if (task.steps.some((s) => s.state !== 'completed'))
        throw new ServiceError('verification_required', 'Every step must be reviewed or verified');
      const checks = requiredChecks(task).map((c) => this.latest(task, c.key, null));
      const missing: string[] = [];
      if (!task.acceptance.length) missing.push('No configured acceptance checks');
      if (!task.deliverables.length) missing.push('No configured deliverable paths');
      for (let n = 0; n < checks.length; n++)
        if (
          !checks[n] ||
          (protectedResult
            ? !protectedResult.evidence.some((e) => e.check_id === checks[n]!.id)
            : !this.fresh(checks[n]!))
        )
          missing.push('Fresh check required: ' + requiredChecks(task)[n]!.key);
      let workspace: { id: string; revision: number; digest: string } | null = null,
        deliverables: unknown[] = [],
        diff: unknown = null;
      try {
        if (protectedResult) {
          const e = protectedResult.evidence[0]!;
          workspace = { id: 'station:' + e.root_digest, revision: 0, digest: e.tree_digest };
          // Keep each deliverable's verified bytes as a session artifact, committed with the
          // completion, so publication reads the verified revision and never the live workspace.
          deliverables = (
            protectedResult.deliverables as { path: string; sha256: string; content: string }[]
          ).map(({ path, sha256, content }) => {
            if (typeof content !== 'string')
              throw new ServiceError('verification_required', 'Deliverable bytes unavailable');
            const artifact = this.artifacts.prepare(task.session_id, content);
            artifact.commit();
            return { path, sha256, artifact_id: artifact.id };
          });
          diff = {
            backend: 'linux-systemd-station-v1',
            root_digest: e.root_digest,
            configuration_digest: e.configuration_digest,
            workspace_digest: e.tree_digest,
          };
        } else {
          const owned = this.workspaces.verify(task.session_id);
          workspace = owned;
          const tree = readTree(owned.root),
            baseline = JSON.parse(this.artifacts.read(owned.baseline));
          for (const path of task.deliverables)
            if (!tree[path]) missing.push('Missing deliverable: ' + path);
            else deliverables.push({ path, digest: digest(tree[path]) });
          diff = { baseline_digest: digest(baseline), workspace_digest: digest(tree) };
        }
      } catch (error) {
        missing.push('Workspace verification unavailable: ' + (error as Error).message);
      }
      // Item 8: a declared critic must have passed this exact verified evidence.
      if (
        task.completion_gate?.critic &&
        !(protectedResult && this.critic?.passed(task, digest(protectedResult.evidence)))
      )
        missing.push('Critic review required');
      if (missing.length && !exception)
        throw new ServiceError('verification_required', missing.join('; '));
      if (exception) {
        if (
          !this.store.db
            .prepare('SELECT 1 FROM artifacts WHERE id=? AND session_id=?')
            .get(exception.evidence_artifact, task.session_id)
        )
          throw new ServiceError(
            'invalid_artifact',
            'Exception evidence must belong to this task session',
          );
        this.artifacts.read(exception.evidence_artifact);
      }
      const state = exception ? 'succeeded_with_exception' : 'succeeded';
      const evidence = this.artifacts.prepare(
        task.session_id,
        canonical({
          task_id: id,
          plan_revision: task.plan_revision,
          workspace,
          checks: checks.map((c) => c?.id ?? null),
          deliverables,
          diff,
          exception,
          missing_requirements: missing,
          verified: !exception,
        }),
      );
      evidence.commit();
      this.store.db
        .prepare(
          'INSERT INTO task_completions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET plan_revision=excluded.plan_revision,workspace_id=excluded.workspace_id,workspace_revision=excluded.workspace_revision,workspace_digest=excluded.workspace_digest,artifact_id=excluded.artifact_id,state=excluded.state,exception=excluded.exception',
        )
        .run(
          id,
          task.plan_revision,
          workspace?.id ?? null,
          workspace?.revision ?? null,
          workspace?.digest ?? null,
          evidence.id,
          state,
          exception ? canonical(exception) : null,
        );
      this.store.db
        .prepare('UPDATE durable_tasks SET state=?,reason=?,revision=revision+1 WHERE id=?')
        .run(
          state,
          exception
            ? 'Completed with an explicit operator exception'
            : 'Configured checks and deliverables verified at the recorded workspace revision',
          id,
        );
      this.store.db.prepare('UPDATE task_runtime SET auto_enabled=0 WHERE task_id=?').run(id);
      this.store.event(task.session_id, 'work_task.' + state, {
        task_id: id,
        artifact_id: evidence.id,
        verified: !exception,
      });
      return { id };
    });
    return this.tasks.get(id);
  }
  view(task: WorkTask): unknown {
    const completion = this.store.db
      .prepare('SELECT * FROM task_completions WHERE task_id=?')
      .get(task.id);
    let fresh = !!completion;
    if (completion) {
      if (completion.workspace_id === null) {
        fresh =
          completion.plan_revision === task.plan_revision &&
          completion.state === 'succeeded_with_exception';
        this.artifacts.read(String(completion.artifact_id));
      } else
        try {
          const evidence = JSON.parse(this.artifacts.read(String(completion.artifact_id)));
          const w = this.workspaces.verify(task.session_id);
          fresh =
            completion.plan_revision === task.plan_revision &&
            completion.workspace_digest === w.digest &&
            completion.workspace_revision === w.revision;
          if (completion.state === 'succeeded')
            fresh =
              fresh &&
              requiredChecks(task).every((check) => {
                const latest = this.latest(task, check.key, null);
                return !!latest && evidence.checks.includes(latest.id) && this.fresh(latest);
              });
        } catch {
          fresh = false;
        }
    }
    return {
      checks: this.list(task.id).map((c) => ({ ...c, fresh: this.fresh(c) })),
      completion: completion ? { ...completion, fresh } : null,
    };
  }
}
