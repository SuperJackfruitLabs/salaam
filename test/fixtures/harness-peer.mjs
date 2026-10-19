import { createInterface } from 'node:readline';
const mode = process.argv[2],
  dialect = process.argv[3] ?? 'acp';
const send = (value) =>
  process.stdout.write(
    JSON.stringify({ ...(dialect === 'acp' ? { jsonrpc: '2.0' } : {}), ...value }) + '\n',
  );
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const m = JSON.parse(line);
  if (mode === 'silent') continue;
  if (mode === 'malformed') {
    process.stdout.write('not JSON\n');
    continue;
  }
  if (mode === 'dialect') {
    process.stdout.write(JSON.stringify({ jsonrpc: '1.0', id: m.id, result: {} }) + '\n');
    continue;
  }
  if (mode === 'oversize') {
    process.stdout.write('x'.repeat(1024 * 1024 + 1));
    continue;
  }
  if (mode === 'invalid-utf8') {
    process.stdout.write(Buffer.from([255, 10]));
    continue;
  }
  if (mode === 'truncated') {
    process.stdout.write('{');
    process.exit(0);
  }
  if (mode === 'wrong-id') {
    send({ id: 999, result: {} });
    continue;
  }
  if (mode === 'primitive') {
    send({ id: m.id, result: 'invalid' });
    continue;
  }
  if (mode === 'error') {
    send({ id: m.id, error: { code: -32601, message: 'unsupported' } });
    continue;
  }
  if (mode === 'permission' && m.method !== undefined) {
    send({
      id: 'approval',
      method: 'session/request_permission',
      params: { sessionId: 'unowned' },
    });
    continue;
  }
  if (mode === 'permission' && m.error) {
    send({ id: 1, result: { denied: true } });
    continue;
  }
  const result = { echo: m.params, method: m.method };
  if (mode === 'fragment') {
    const frame =
      JSON.stringify({ ...(dialect === 'acp' ? { jsonrpc: '2.0' } : {}), id: m.id, result }) + '\n';
    for (const byte of Buffer.from(frame)) process.stdout.write(Buffer.from([byte]));
    continue;
  }
  send({ id: m.id, result });
  if (mode === 'duplicate') send({ id: m.id, result });
}
