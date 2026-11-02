// A session's snapshot: its attempts, submissions, conversation, approvals, operations and
// children, each bounded so a snapshot stays small.
import type {
  Approval,
  Attempt,
  Submission,
  ControlView,
  Operation,
  SessionSnapshot,
  WorkerBoundaryView,
  AgentGrantSnapshot,
} from '../core/index.js';
import type { Journal } from './journal.js';

export interface SnapshotStore extends Journal {
  readonly workerBoundary: {
    view(childId: string): WorkerBoundaryView;
    profiles?: { snapshot(session: string): AgentGrantSnapshot[] };
  };
  teamSnapshot?: (session: string) => unknown;
  controlView(id: string): ControlView;
  approvals(id: string): Approval[];
  operations(id: string): Operation[];
}

export function snapshot(store: SnapshotStore, id: string): SessionSnapshot {
  const session = store.session(id);
  const attempts = store.db
    .prepare(
      "SELECT * FROM attempts WHERE session_id=? ORDER BY (state='interrupted' AND resolved_by IS NULL) DESC,rowid DESC LIMIT 100",
    )
    .all(id) as unknown as Attempt[];
  const submissions = store.db
    .prepare('SELECT * FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
    .all(id) as unknown as Submission[];
  let resultBudget = 65536;
  let inputBudget = 65536;
  let errorBudget = 65536;
  const boundedAttempts = attempts.map((attempt) => {
    const cap = Math.min(resultBudget, 8192);
    const result = attempt.result?.slice(0, cap) ?? null;
    resultBudget -= result?.length ?? 0;
    const error = attempt.error?.slice(0, Math.min(4096, errorBudget)) ?? null;
    errorBudget -= error?.length ?? 0;
    return {
      ...attempt,
      outcome: attempt.outcome ? JSON.parse(String(attempt.outcome)) : null,
      result,
      error,
      result_truncated: (attempt.result?.length ?? 0) > cap,
    };
  });
  const boundedSubmissions = submissions.map((submission) => {
    const cap = Math.min(inputBudget, 8192);
    inputBudget -= Math.min(submission.text.length, cap);
    return {
      ...submission,
      text: submission.text.slice(0, cap),
      text_truncated: submission.text.length > cap,
    };
  });
  let cursor = session.pi_leaf;
  const seen = new Set<string>();
  const lookup = store.db.prepare(
    'SELECT payload FROM pi_entries WHERE session_id=? AND entry_id=?',
  );
  let remaining = 256 * 1024;
  const messages: SessionSnapshot['messages'] = [];
  // Walking back from the newest entry: tool calls belong just before the message that follows
  // them, so a turn's calls are shown in place rather than gathered at the end.
  let trailing: string[] = [];
  while (
    cursor &&
    !seen.has(cursor) &&
    seen.size < 10000 &&
    remaining > 0 &&
    messages.length < 100
  ) {
    seen.add(cursor);
    const row = lookup.get(id, cursor) as { payload: string } | undefined;
    if (!row) break;
    const entry = JSON.parse(row.payload);
    cursor = entry.parentId ?? null;
    const message = entry.message;
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    if (Array.isArray(message.content)) {
      const calls = message.content
        .filter((part: { type: string; id?: unknown }) => part.type === 'toolCall')
        .map((part: { id: unknown }) => String(part.id));
      const later = messages.at(-1);
      if (calls.length && later) later.tool_calls = [...calls, ...(later.tool_calls ?? [])];
      else if (calls.length) trailing = [...calls, ...trailing];
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part: { type: string }) => part.type === 'text')
            .map((part: { text: string }) => part.text)
            .join('');
    if (!text) continue;
    const cap = Math.min(65536, remaining);
    if (cap <= 0 || messages.length >= 100) break;
    messages.push({
      entry_id: entry.id,
      role: message.role,
      text: text.slice(0, cap),
      truncated: text.length > cap,
    });
    remaining -= Math.min(text.length, cap);
  }
  return {
    ...session,
    ...(store.db.prepare('SELECT id FROM agentpod_admissions WHERE session_id=?').get(id)
      ? {
          agentpod_admission_id: String(
            store.db.prepare('SELECT id FROM agentpod_admissions WHERE session_id=?').get(id)!.id,
          ),
        }
      : {}),
    control: store.controlView(id),
    attempts: boundedAttempts,
    submissions: boundedSubmissions,
    messages: messages.reverse(),
    ...(trailing.length ? { trailing_tool_calls: trailing } : {}),
    history_truncated: cursor !== null,
    approvals: store.approvals(id),
    operations: store.operations(id),
    children: (
      store.db
        .prepare('SELECT * FROM child_tasks WHERE parent_session=? ORDER BY rowid DESC LIMIT 100')
        .all(id) as unknown as SessionSnapshot['children']
    ).map((child) => ({
      ...child,
      worker: store.workerBoundary.view(child.id),
    })),
    ...(store.workerBoundary.profiles
      ? { agents: store.workerBoundary.profiles.snapshot(id) }
      : {}),
    ...(store.teamSnapshot ? { team: store.teamSnapshot(id) } : {}),
  };
}
export function approvals(store: Journal, id: string): Approval[] {
  store.session(id);
  return store.db
    .prepare('SELECT * FROM approvals WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
    .all(id) as unknown as Approval[];
}
export function operations(store: Journal, id: string): Operation[] {
  store.session(id);
  const rows = store.db
    .prepare(
      "SELECT * FROM operations WHERE session_id=? ORDER BY (state='outcome_unknown') DESC,rowid DESC LIMIT 100",
    )
    .all(id) as unknown as Operation[];
  return rows.map((op) => ({
    ...op,
    value: op.value.slice(0, 256),
    value_truncated: op.value.length > 256,
    receipt: null,
    receipt_available: op.receipt !== null,
    error: op.error?.slice(0, 512) ?? null,
    resolution: op.resolution?.slice(0, 512) ?? null,
  }));
}
