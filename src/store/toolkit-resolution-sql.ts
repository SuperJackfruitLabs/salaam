/** The SQL test that a Toolkit call has a committed operator resolution for its current revision.
 * The store and the Toolkit ledgers share it; it imports nothing. */
export function resolvedToolkitCallSql(alias: string): string {
  if (!/^[a-z]+$/.test(alias)) throw Error('Invalid internal SQL alias');
  return `EXISTS(SELECT 1 FROM toolkit_resolutions tr WHERE tr.call_id=${alias}.id AND tr.state='committed' AND tr.call_revision=${alias}.revision AND tr.request_digest=${alias}.request_digest)`;
}
