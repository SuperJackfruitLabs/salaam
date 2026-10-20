import type { Store } from './store.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import type { TaskWork } from './task-work.js';
import type { TaskVerification } from './task-verification.js';
import { canonical, digest, ServiceError } from './protocol.js';
import {
  agentpodWorkAdmission,
  checkAgentPodWorkAdmission,
  type AgentPodWorkIdentity,
} from './agentpod-work-protocol.js';

export interface AgentPodWorkReceipt {
  version: 1;
  state: 'admitted';
  session_id: string;
  task_id: string;
  request_id: string;
  binding_digest: string;
  plan_revision: number;
}
/** Private control-only, not advertised. The authenticated control
 * adapter must supply its own session and independently admitted work identity.
 * This receipt records task admission, never successful work or permission to run.
 */
export class AgentPodWork {
  constructor(
    readonly store: Store,
    readonly authority: AgentPodAuthority,
    readonly tasks: TaskWork,
    readonly verification: TaskVerification,
  ) {}

  async completion(binding: unknown) {
    const root = this.authority.inspect(binding);
    const row = this.store.db
      .prepare('SELECT * FROM agentpod_work WHERE session_id=?')
      .get(root.session_id);
    if (!row) throw new ServiceError('work_missing', 'Admitted work required');
    const admission = agentpodWorkAdmission(JSON.parse(String(row.admission_json)));
    if (canonical(admission.binding) !== canonical(root.binding))
      throw new ServiceError('work_authority_mismatch', 'Exact work authority required');
    this.store.execution.assert(root.session_id);
    const task = this.tasks.get(String(row.task_id));
    if (!this.verification.station || task.state !== 'succeeded')
      throw new ServiceError('verification_required', 'Protected verified completion required');
    const view = (await this.verification.viewAsync(task)) as {
      completion: Record<string, unknown> | null;
    };
    this.store.execution.assert(root.session_id);
    const current = this.tasks.get(task.id),
      completion = view.completion;
    if (
      current.revision !== task.revision ||
      current.plan_revision !== task.plan_revision ||
      current.state !== 'succeeded' ||
      !completion?.fresh ||
      completion.state !== 'succeeded' ||
      completion.plan_revision !== task.plan_revision
    )
      throw new ServiceError('verification_required', 'Fresh unchanged completion required');
    this.verification.assertIdle(current);
    const record = this.store.db
      .prepare('SELECT * FROM task_completions WHERE task_id=?')
      .get(task.id);
    if (!record || record.artifact_id !== completion.artifact_id)
      throw new ServiceError('verification_required', 'Completion changed');
    const evidence = JSON.parse(this.verification.artifacts.read(String(record.artifact_id)));
    this.store.execution.assert(root.session_id);
    return {
      version: 1 as const,
      state: 'verified' as const,
      work_request_id: String(row.request_id),
      task_id: task.id,
      plan_revision: task.plan_revision,
      binding_digest: digest(root.binding),
      completion_id: String(record.artifact_id),
      evidence_digest: digest(evidence),
    };
  }

  admit(
    session: string,
    value: unknown,
    expected: Pick<AgentPodWorkIdentity, 'board_id' | 'card_id' | 'stage_key'>,
    input: unknown,
    rawPlan: unknown,
  ): AgentPodWorkReceipt {
    const admission = agentpodWorkAdmission(value);
    // Immutable root/principal read binding precedes saved receipt access; freshness
    // is reserved for NEW work below so a lost original reply remains recoverable.
    const root = this.authority.inspect(admission.binding);
    if (root.session_id !== session)
      throw new ServiceError('work_authority_mismatch', 'Work receipt belongs to another session');
    const plan = this.tasks.parse(rawPlan);
    const checked = checkAgentPodWorkAdmission(admission, {
      binding: root.binding,
      work: { ...expected, input_digest: digest(input), plan_digest: digest(plan) },
    });
    if (!checked.ok)
      throw new ServiceError(
        checked.code,
        'Work admission does not match admitted bytes or authority',
      );
    const receipt = this.store.request<AgentPodWorkReceipt>(
      'agentpod-work',
      admission.request_id,
      { kind: 'work-admit', session, admission, input, plan },
      () => {
        this.store.execution.assert(session);
        if (canonical(this.authority.binding(session)) !== canonical(admission.binding))
          throw new ServiceError('work_authority_mismatch', 'Work authority changed');
        const runKey = canonical({
          organization: admission.binding.organization_id,
          source: admission.binding.run.source,
          run: admission.binding.run.id,
        });
        const table = this.store.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agentpod_work'")
          .get();
        if (
          table &&
          this.store.db
            .prepare('SELECT 1 FROM agentpod_work WHERE run_key=? OR session_id=?')
            .get(runKey, session)
        )
          throw new ServiceError(
            'work_request_conflict',
            'Recover the original work request; this run already owns a task',
          );
        if (
          this.store.hasUnknown(session) ||
          this.store.db
            .prepare(
              "SELECT 1 FROM station_calls WHERE session_id=? AND (state IN ('prepared','dispatching','outcome_unknown') OR helper_state NOT IN ('none','stopped'))",
            )
            .get(session) ||
          this.store.db
            .prepare("SELECT 1 FROM station_units WHERE session_id=? AND state!='stopped'")
            .get(session)
        )
          throw new ServiceError('work_uncertain', 'Station execution is active or not reconciled');
        const task = this.tasks.createInTransaction(session, admission.request_id, 0, plan, () =>
          this.store.execution.assert(session),
        );
        this.verification.assertIdle(task);
        // Admission requires the configured verifier to prove its actual execution
        // binding. A missing or unready backend rolls the entire task back.
        const verification = this.verification.binding(task);
        // Filesystem/profile verification can consume the remaining lease window.
        this.store.execution.assert(session);
        this.store.db.exec(`CREATE TABLE IF NOT EXISTS agentpod_work(
          run_key TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
          task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id),request_id TEXT NOT NULL UNIQUE,
          admission_json TEXT NOT NULL,verification_json TEXT NOT NULL);
          `);
        if (Number(this.store.db.prepare('PRAGMA user_version').get()!.user_version) < 29)
          this.store.db.exec('PRAGMA user_version=29');
        this.store.db
          .prepare('INSERT INTO agentpod_work VALUES (?,?,?,?,?,?)')
          .run(
            runKey,
            session,
            task.id,
            admission.request_id,
            canonical(admission),
            canonical(verification),
          );
        const receipt: AgentPodWorkReceipt = {
          version: 1,
          state: 'admitted',
          session_id: session,
          task_id: task.id,
          request_id: admission.request_id,
          binding_digest: digest(admission.binding),
          plan_revision: task.plan_revision,
        };
        this.store.event(session, 'agentpod.work_admitted', receipt, admission.request_id);
        return receipt;
      },
    );
    const saved = this.store.db
      .prepare(
        'SELECT task_id,admission_json FROM agentpod_work WHERE session_id=? AND request_id=?',
      )
      .get(session, admission.request_id);
    if (
      !saved ||
      saved.task_id !== receipt.task_id ||
      saved.admission_json !== canonical(admission)
    )
      throw new ServiceError(
        'invalid_work_record',
        'Saved task admission mapping is unavailable or changed',
      );
    return receipt;
  }
}
