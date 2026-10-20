import type { Store } from './store.js';
import { digest, object, ServiceError } from './protocol.js';

/** Counts provider requests only; tool results' nested totals are never added. */
export class UsageLedger {
  constructor(private store: Store) {}
  budget(attempt: string, limit = 16): void {
    this.store.db
      .prepare('INSERT OR IGNORE INTO attempt_budgets(attempt_id,limit_requests) VALUES (?,?)')
      .run(attempt, limit);
  }
  admit(
    session: string,
    attempt: string | undefined,
    key: string,
    provider: string,
    model: string,
    bounds?: { input: number; output: number },
  ): void {
    try {
      this.store.transaction(() => {
        const old = this.store.db
          .prepare('SELECT * FROM usage_observations WHERE source_key=?')
          .get(key);
        if (old)
          throw new ServiceError('request_replay', 'A provider request cannot be forwarded twice');
        this.store.execution.assert(session);
        this.store.taskModelAdmission?.(session, attempt, bounds?.input ?? 0, bounds?.output ?? 0);
        if (attempt) {
          this.budget(attempt);
          const changed = this.store.db
            .prepare(
              'UPDATE attempt_budgets SET spent_requests=spent_requests+1 WHERE attempt_id=? AND spent_requests+reserved_requests<limit_requests',
            )
            .run(attempt);
          if (!changed.changes)
            throw new ServiceError('budget_exhausted', 'No model request budget remains');
        }
        this.store.db
          .prepare(
            "INSERT INTO usage_observations(source_key,session_id,attempt_id,provider,model,status) VALUES (?,?,?,?,?,'unknown')",
          )
          .run(key, session, attempt ?? null, provider, model);
        this.store.event(session, 'usage.admitted', {
          source_key: key,
          attempt_id: attempt ?? null,
        });
      });
    } catch (error) {
      this.store.taskBudgetDenied?.(session, error);
      throw error;
    }
  }
  observe(
    session: string,
    key: string,
    provider: string,
    model: string,
    usage: unknown,
    status: 'known' | 'estimated' = 'known',
  ): void {
    const u = object(usage),
      cost = object(u.cost);
    const values = [u.input, u.output, u.cacheRead, u.cacheWrite, cost.total];
    if (values.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0))
      throw new ServiceError('invalid_usage', 'Invalid usage observation');
    const hash = digest({ provider, model, values, status });
    const old = this.store.db
      .prepare('SELECT * FROM usage_observations WHERE source_key=?')
      .get(key);
    if (
      old &&
      (old.session_id !== session ||
        old.provider !== provider ||
        old.model !== model ||
        (old.payload_digest && old.payload_digest !== hash))
    )
      throw new ServiceError('usage_conflict', 'Usage source changed');
    if (old?.payload_digest) return;
    if (!old)
      this.store.db
        .prepare(
          "INSERT INTO usage_observations(source_key,session_id,provider,model,status) VALUES (?,?,?,?,'unknown')",
        )
        .run(key, session, provider, model);
    this.store.db
      .prepare(
        'UPDATE usage_observations SET status=?,input=?,output=?,cache_read=?,cache_write=?,cost=?,payload_digest=? WHERE source_key=?',
      )
      .run(status, ...(values as number[]), hash, key);
    this.store.event(session, 'usage.observed', { source_key: key, status });
  }
  importEntries(session: string, entries: { id: string }[]): void {
    for (const value of entries) {
      const entry = value as {
        id: string;
        type?: string;
        message?: Record<string, unknown>;
        usage?: unknown;
        details?: { strategy?: string; salaam_compaction?: string };
        provider?: string;
        model?: string;
      };
      // Inherited records are context, not a new provider charge for the branch.
      const inherited = this.store.db
        .prepare(
          `SELECT p.payload FROM events f JOIN pi_entries p ON p.session_id=json_extract(f.payload,'$.parent') AND p.entry_id=? WHERE f.session_id=? AND f.kind='session.forked' AND p.rowid <= (SELECT rowid FROM pi_entries WHERE session_id=p.session_id AND entry_id=json_extract(f.payload,'$.cursor')) LIMIT 1`,
        )
        .get(entry.id, session) as { payload: string } | undefined;
      if (inherited && digest(JSON.parse(inherited.payload)) === digest(entry)) continue;
      const m = entry.message;
      const checkpoint =
        entry.type === 'compaction' &&
        entry.details?.strategy === 'explicit-task-checkpoint-v1' &&
        typeof entry.details.salaam_compaction === 'string';

      if (
        m?.role !== 'assistant' &&
        !['compaction', 'branch_summary', 'usage'].includes(entry.type ?? '')
      )
        continue;
      const key =
        typeof m?.responseId === 'string' && m.responseId.startsWith('salaam-request:')
          ? m.responseId
          : `pi:${session}:${entry.id}`;
      // Managed live streams report receipts through the authenticated bridge.
      // Pi normalizes a missing receipt to zeros; importing that transcript must
      // never upgrade a conservatively unknown observation to a zero charge.
      if (key.startsWith('salaam-request:')) {
        const managed = this.store.db
          .prepare('SELECT session_id,provider FROM usage_observations WHERE source_key=?')
          .get(key);
        if (managed && managed.provider !== 'salaam-proof') {
          if (managed.session_id !== session)
            throw new ServiceError('invalid_usage', 'Usage does not belong to this session');
          continue;
        }
        // A rejected live request can still produce a Pi error transcript. Its
        // absence from admission is definitive: no request was dispatched.
        const route = this.store.providerRoute(session);
        if (!managed && route && route.provider !== 'salaam-proof') continue;
      }
      // An aborted provider message may carry placeholder zeros. They are not evidence of zero spend.
      const complete = m && !['error', 'aborted'].includes(String(m.stopReason));
      if ((complete && m.usage) || entry.usage)
        this.observe(
          session,
          key,
          checkpoint ? 'salaam-checkpoint' : String(m?.provider ?? entry.provider ?? 'unknown'),
          checkpoint
            ? 'deterministic-v1'
            : String(m?.model ?? entry.model ?? entry.type ?? 'unknown'),
          entry.usage ?? m?.usage,
          checkpoint || (m?.provider ?? entry.provider) === 'salaam-proof' ? 'known' : 'estimated',
        );
      else if (
        !this.store.db.prepare('SELECT 1 FROM usage_observations WHERE source_key=?').get(key)
      )
        this.store.db
          .prepare(
            "INSERT INTO usage_observations(source_key,session_id,provider,model,status) VALUES (?,?,?,?,'unknown')",
          )
          .run(
            key,
            session,
            String(m?.provider ?? entry.provider ?? 'unknown'),
            String(m?.model ?? entry.model ?? entry.type ?? 'unknown'),
          );
    }
  }
  summary(session: string): unknown {
    this.store.session(session);
    return this.store.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT c.child_session FROM child_tasks c JOIN tree t ON c.parent_session=t.id)
      SELECT count(*) AS observations,coalesce(sum(status='unknown'),0) AS unknown_observations,coalesce(sum(status='estimated'),0) AS estimated_observations,
      coalesce(sum(input),0) AS known_input,coalesce(sum(output),0) AS known_output,coalesce(sum(cache_read),0) AS known_cache_read,
      coalesce(sum(cache_write),0) AS known_cache_write,coalesce(sum(CASE WHEN status='known' THEN cost ELSE 0 END),0) AS known_cost,coalesce(sum(CASE WHEN status='estimated' THEN cost ELSE 0 END),0) AS estimated_cost FROM usage_observations WHERE session_id IN (SELECT id FROM tree)`,
      )
      .get(session);
  }
}
