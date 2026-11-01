import type { Store } from './store.js';
import { digest, ServiceError } from '../core/protocol.js';

type UsageRow = {
  source_key: string;
  session_id: string;
  attempt_id: string | null;
  provider: string;
  model: string;
  status: 'known' | 'estimated' | 'unknown';
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
  payload_digest: string | null;
};

const TREE = `WITH RECURSIVE tree(id) AS (
  SELECT ? UNION SELECT child_session FROM child_tasks JOIN tree ON parent_session=tree.id
)`;

/** Current ledger facts, not an immutable artifact or evidence of provider billing.
 * The source key owns deduplication; neither transcript replay nor telemetry adds a charge.
 * Keep this internal projection separate from a version-negotiated cross-product wire.
 */
export function usageEvidence(store: Store, session: string, limit = 256) {
  store.session(session);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    throw new ServiceError('invalid_usage_evidence_limit', 'Usage evidence limit must be 1–256');
  const scope = 'session_id IN (SELECT id FROM tree)';
  const counts = store.db
    .prepare(
      `${TREE} SELECT count(*) AS observations,
      coalesce(sum(status='unknown'),0) AS unknown,
      coalesce(sum(status='estimated'),0) AS estimated,
      coalesce(sum(status NOT IN ('known','estimated','unknown')),0) AS invalid
      FROM usage_observations WHERE ${scope}`,
    )
    .get(session)!;
  if (Number(counts.invalid) > 0)
    throw new ServiceError('invalid_usage_evidence', 'Unsupported usage observation status');
  const rows = store.db
    .prepare(
      `${TREE} SELECT * FROM usage_observations WHERE ${scope}
      ORDER BY source_key LIMIT ?`,
    )
    .all(session, limit) as unknown as UsageRow[];
  const observations = Number(counts.observations),
    unknown = Number(counts.unknown),
    estimated = Number(counts.estimated),
    recorded = observations - unknown;
  const sums = store.db
    .prepare(
      `${TREE} SELECT sum(input) AS input, sum(output) AS output,
      sum(cache_read) AS cache_read, sum(cache_write) AS cache_write, sum(cost) AS cost
      FROM usage_observations WHERE ${scope} AND status IN ('known','estimated')`,
    )
    .get(session)!;
  const amount = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new ServiceError('invalid_usage_evidence', 'Invalid recorded usage amount');
    return value;
  };
  const values = (row: Record<string, unknown>) => ({
    input_tokens: amount(row.input),
    output_tokens: amount(row.output),
    cache_read_tokens: amount(row.cache_read),
    cache_write_tokens: amount(row.cache_write),
    cost_usd: amount(row.cost),
  });
  return {
    version: 1 as const,
    recorded_by: 'salaam-usage-ledger' as const,
    session_id: session,
    includes_children: true,
    status:
      observations === 0
        ? ('unreported' as const)
        : recorded === 0
          ? ('unknown' as const)
          : unknown > 0
            ? ('partial' as const)
            : estimated > 0
              ? ('estimated' as const)
              : ('known' as const),
    coverage: { observations, recorded, unknown, estimated },
    // A subtotal is explicitly labelled. It is never the missing portion's price.
    recorded_subtotal: recorded > 0 ? values(sums) : null,
    cost_provenance: recorded > 0 ? 'ledger-recorded-not-provider-bill' : 'unknown',
    truncated: observations > rows.length,
    observations: rows.map((row) => {
      if (!['known', 'estimated', 'unknown'].includes(row.status))
        throw new ServiceError('invalid_usage_evidence', 'Unsupported usage observation status');
      const known = row.status !== 'unknown';
      if (
        known &&
        digest({
          provider: row.provider,
          model: row.model,
          values: [row.input, row.output, row.cache_read, row.cache_write, row.cost],
          status: row.status,
        }) !== row.payload_digest
      )
        throw new ServiceError('invalid_usage_evidence', 'Usage observation digest mismatch');
      if (!known && row.payload_digest !== null)
        throw new ServiceError('invalid_usage_evidence', 'Unknown usage cannot have a receipt');
      return {
        source_key: row.source_key,
        session_id: row.session_id,
        attempt_id: row.attempt_id,
        provider: row.provider,
        model: row.model,
        status: row.status,
        recorded_values: known ? values(row) : null,
        observation_digest: row.payload_digest,
        digest_verified: known ? true : null,
        token_provenance: known ? 'ledger-recorded' : 'unknown',
        cost_provenance: known ? 'ledger-recorded-not-provider-bill' : 'unknown',
      };
    }),
  };
}
