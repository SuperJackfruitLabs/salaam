import type { Store } from './store.js';
import type { TaskWork, WorkTask } from './task-work.js';
import type { TaskVerification, CheckReceipt } from './task-verification.js';
import type { StationWork, StationBinding, StationCall } from './station-work.js';
import type { Artifacts } from './artifacts.js';
import { canonical, digest, ServiceError } from './protocol.js';

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
/** Backend adapter for task_checks, deliberately not installed in the daemon.
 * It never changes task success. The controller must await withFresh and commit
 * its check/completion state in the synchronous transaction callback, not cache
 * an asynchronous boolean. Durable binding predates native command dispatch. */
export class StationTaskVerification {
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly verification: TaskVerification,
    readonly station: StationWork,
    readonly artifacts: Artifacts,
  ) {}
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
    const configured = task.acceptance.find((c) => c.key === check.check_key);
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
    return this.store.request('station-task-check', checkID, { checkID, callID }, () => {
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
  async withFresh<T>(checkID: string, consume: (evidence: StationCheckEvidence) => T): Promise<T> {
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
    const before = validate();
    const revision = before.current.revision;
    const resultDigest = digest(before.result);
    const observed = await this.station.verificationTree(bound.call_id, validate);
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
      if (value && typeof (value as { then?: unknown }).then === 'function')
        throw new ServiceError(
          'verification_required',
          'Verification consumer must commit synchronously',
        );
      return value;
    });
  }
}
