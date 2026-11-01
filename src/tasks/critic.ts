import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { Artifacts } from '../store/artifacts.js';
import type { AgentGrant } from '../core/worker-binding.js';
import type { WorkTask, WorkspaceTree } from '../core/records.js';
import type { ChildTask } from '../core/protocol.js';

/**
 * The completion critic (item 8). When the admitted plan declares a critic, the built-in reviewer
 * reads an immutable snapshot of the verified deliverables against the plan's rubric before the
 * task may complete. Its verdict is bound to the exact verified evidence (checks and tree): any
 * later change makes it stale. A critical or high finding means changes are needed; a reviewer
 * that reports nothing at all is a failure, never a pass.
 */
export const CRITIC_BUDGET = 4;
export const CRITIC_REOPENS = 2;
export type CriticVerdict =
  | { state: 'pass' }
  | { state: 'pending' }
  | { state: 'changes_needed'; findings: CriticFinding[] }
  | { state: 'failed'; reason: string };
export interface CriticFinding {
  path: string;
  line: number;
  severity: string;
  message: string;
}
export interface CriticDeps {
  admit(task: WorkTask, request: string): Promise<AgentGrant>;
  spawn(
    task: WorkTask,
    parentAttempt: string,
    step: string,
    prompt: string,
    budget: number,
    grant: AgentGrant,
    snapshot: WorkspaceTree,
  ): ChildTask;
  workerId(childId: string): string;
}

export class TaskCritic {
  constructor(
    private readonly store: Store,
    private readonly artifacts: Artifacts,
    private readonly deps: CriticDeps,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_critics(
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      evidence_digest TEXT NOT NULL,
      round INTEGER NOT NULL,
      child_id TEXT NOT NULL,
      state TEXT NOT NULL,
      findings TEXT,
      reason TEXT,
      UNIQUE(task_id, plan_revision, evidence_digest))`);
  }
  /** Whether this exact verified evidence has a passing critic verdict. */
  passed(task: WorkTask, evidenceDigest: string): boolean {
    return (
      this.store.db
        .prepare(
          "SELECT 1 FROM task_critics WHERE task_id=? AND plan_revision=? AND evidence_digest=? AND state='pass'",
        )
        .get(task.id, task.plan_revision, evidenceDigest) !== undefined
    );
  }
  /** How many times the critic has sent this plan revision back for changes. */
  reopens(task: WorkTask): number {
    return Number(
      this.store.db
        .prepare(
          "SELECT count(*) AS n FROM task_critics WHERE task_id=? AND plan_revision=? AND state='changes_needed'",
        )
        .get(task.id, task.plan_revision)!.n,
    );
  }
  /** The verdict for this verified evidence, starting the reviewer the first time it is asked. */
  async gate(
    task: WorkTask,
    evidenceDigest: string,
    deliverables: { path: string; content: string }[],
  ): Promise<CriticVerdict> {
    const critic = task.completion_gate?.critic;
    if (!critic) return { state: 'pass' };
    const row = this.store.db
      .prepare(
        'SELECT * FROM task_critics WHERE task_id=? AND plan_revision=? AND evidence_digest=?',
      )
      .get(task.id, task.plan_revision, evidenceDigest);
    if (row) return this.settle(row);
    const last = this.store.db
      .prepare(
        'SELECT b.attempt_id FROM task_step_attempts b JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=? ORDER BY b.rowid DESC LIMIT 1',
      )
      .get(task.id);
    if (!last) return { state: 'failed', reason: 'No step attempt for the critic to follow' };
    if (!deliverables.length)
      return { state: 'failed', reason: 'No verified deliverables to review' };
    const round =
      Number(
        this.store.db
          .prepare('SELECT count(*) AS n FROM task_critics WHERE task_id=? AND plan_revision=?')
          .get(task.id, task.plan_revision)!.n,
      ) + 1;
    const snapshot: WorkspaceTree = Object.fromEntries(
      deliverables.map((d) => [
        d.path,
        { content: Buffer.from(d.content, 'utf8').toString('base64'), executable: false },
      ]),
    );
    const grant = await this.deps.admit(task, `critic:${task.id}:${task.plan_revision}`);
    const child = this.deps.spawn(
      task,
      String(last.attempt_id),
      `critic-${task.plan_revision}-${round}`,
      [
        'Judge the delivered work against this rubric before it is accepted:',
        critic.rubric,
        '',
        'Objective: ' + task.objective,
        'Deliverables (the snapshot): ' + deliverables.map((d) => d.path).join(', '),
        '',
        'Report findings with salaam_findings, citing the file and line. Use critical or high only',
        'for what must change before the work is accepted; medium or low for suggestions. If the',
        'work meets the rubric, report an empty list.',
      ].join('\n'),
      CRITIC_BUDGET,
      grant,
      snapshot,
    );
    this.store.db
      .prepare("INSERT INTO task_critics VALUES (?,?,?,?,?,?,'running',NULL,NULL)")
      .run(randomUUID(), task.id, task.plan_revision, evidenceDigest, round, child.id);
    return { state: 'pending' };
  }
  private settle(row: Record<string, unknown>): CriticVerdict {
    if (row.state === 'pass') return { state: 'pass' };
    if (row.state === 'changes_needed')
      return { state: 'changes_needed', findings: JSON.parse(String(row.findings)) };
    if (row.state === 'failed') return { state: 'failed', reason: String(row.reason) };
    const child = this.store.db
      .prepare('SELECT state FROM child_tasks WHERE id=?')
      .get(String(row.child_id));
    if (!child || child.state === 'accepted') return { state: 'pending' };
    const report = this.store.db
      .prepare('SELECT artifact_id FROM specialist_reports WHERE worker_id=?')
      .get(this.deps.workerId(String(row.child_id)));
    const set = (state: string, findings: CriticFinding[] | null, reason: string | null) =>
      this.store.db
        .prepare('UPDATE task_critics SET state=?,findings=?,reason=? WHERE id=?')
        .run(state, findings ? JSON.stringify(findings) : null, reason, String(row.id));
    if (!report) {
      const reason = 'The critic returned no findings report';
      set('failed', null, reason);
      return { state: 'failed', reason };
    }
    const findings = (
      JSON.parse(this.artifacts.read(String(report.artifact_id))).findings as CriticFinding[]
    ).map(({ path, line, severity, message }) => ({ path, line, severity, message }));
    if (findings.some((f) => f.severity === 'critical' || f.severity === 'high')) {
      set('changes_needed', findings, null);
      return { state: 'changes_needed', findings };
    }
    set('pass', findings, null);
    return { state: 'pass' };
  }
}
