import type { Store } from './store.js';
import { digest, ServiceError } from './protocol.js';

/** W3C version 00 only. This module carries correlation, never an authority,
 * model budget, usage observation, or proof of successful product work. */
export function traceParent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(value) ||
    value.slice(3, 35) === '0'.repeat(32) ||
    value.slice(36, 52) === '0'.repeat(16)
  )
    throw new ServiceError('invalid_trace_context', 'Supported nonzero W3C traceparent required');
  return value;
}

function child(parent: string, identity: string): string {
  return `00-${parent.slice(3, 35)}-${digest(['salaam.trace.v1', identity]).slice(0, 16)}-${parent.slice(53)}`;
}

function saved(store: Store, request: string, session: string, root: string) {
  const row = store.db
    .prepare("SELECT response FROM requests WHERE actor='agentpod-work-trace' AND id=?")
    .get(request);
  if (!row) return null;
  const value = JSON.parse(String(row.response));
  if (
    Object.keys(value).sort().join(',') !==
      'authority,parent,root_digest,session_id,traceparent,version' ||
    value.version !== 1 ||
    value.authority !== false ||
    value.root_digest !== root ||
    value.session_id !== session ||
    value.traceparent !== child(traceParent(value.parent), root + ':' + request)
  )
    throw new ServiceError('invalid_trace_record', 'Saved trace ownership or context changed');
  return value as {
    version: 1;
    authority: false;
    root_digest: string;
    session_id: string;
    parent: string;
    traceparent: string;
  };
}

/** Original context wins after reconnect, even if the recovery request has a
 * different tracing parent. Authentication of the original root precedes this.
 */
export function bindWorkTrace(
  store: Store,
  session: string,
  request: string,
  root: string,
  parent: unknown,
) {
  const input = traceParent(parent);
  const previous = saved(store, request, session, root);
  if (previous) return previous;
  return store.request('agentpod-work-trace', request, { session, root, parent: input }, () => {
    const receipt = {
      version: 1 as const,
      authority: false as const,
      root_digest: root,
      session_id: session,
      parent: input,
      traceparent: child(input, root + ':' + request),
    };
    store.event(session, 'evidence.trace_bound', receipt);
    return receipt;
  });
}

/** Correlation for an actual, already-owned invocation; absence stays absent.
 * Session inheritance follows durable child edges, not caller-supplied roots.
 */
export function workTraceHeader(store: Store, session: string, identity: string): string | null {
  if (
    !store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agentpod_work'")
      .get()
  )
    return null;
  const rows = store.db
    .prepare(
      `WITH RECURSIVE parents(id) AS (
    SELECT ? UNION SELECT parent_session FROM child_tasks JOIN parents ON child_session=parents.id
  ) SELECT request_id,session_id,admission_json FROM agentpod_work WHERE session_id IN (SELECT id FROM parents)`,
    )
    .all(session);
  if (!rows.length) return null;
  if (rows.length !== 1) throw new ServiceError('invalid_trace_record', 'Ambiguous trace root');
  const row = rows[0]!,
    admission = JSON.parse(String(row.admission_json));
  const record = saved(
    store,
    String(row.request_id),
    String(row.session_id),
    digest(admission.binding),
  );
  return record
    ? child(record.traceparent, record.root_digest + ':' + session + ':' + identity)
    : null;
}
