import { call } from '../../dist/src/transport.js';
import { CAPABILITIES, textDigest, workerTools } from '../../dist/src/protocol.js';
const c = JSON.parse(process.env.SALAAM_WORKER_CONFIG);
const mode = process.env.SALAAM_TEST_SCENARIO ?? 'ready';
const bridge = (method, body = {}, token = c.token) =>
  call(c.socket, `/worker/${c.session}/${method}`, { epoch: c.epoch, ...body }, token);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const request = JSON.parse(line);
    if (request.type === 'get_state') {
      const args = process.argv.slice(2);
      const dir = args[args.indexOf('--session-dir') + 1];
      const state = {
        sessionId: mode === 'wrong-state' ? 'wrong' : c.session,
        sessionFile: `${dir}/${c.session}.jsonl`,
        model: { provider: 'salaam-proof', id: 'scripted' },
      };
      process.stdout.write(
        JSON.stringify({ type: 'response', id: request.id, success: true, data: state }) + '\n',
      );
    }
  }
});
process.stdin.on('end', () => process.exit());
const manifest = {
  protocol_version: 1,
  bundle_digest: c.bundle,
  policy_digest: c.policy,
  session_id: c.session,
  pi_session_id: c.session,
  epoch: c.epoch,
  capabilities: [...CAPABILITIES],
  tools: workerTools(!!c.effects),
  active_tools: workerTools(!!c.effects),
  provider: 'salaam-proof',
  context_digest: textDigest(c.frame),
};
const mutations = {
  'wrong-version': { protocol_version: 99 },
  'wrong-bundle': { bundle_digest: 'wrong' },
  'wrong-policy': { policy_digest: 'wrong' },
  'wrong-session': { pi_session_id: 'wrong' },
  'wrong-tools': { tools: ['salaam_probe', 'bypass'] },
  'missing-context': { capabilities: ['persistent-session'] },
  'missing-approvals': { capabilities: CAPABILITIES.filter((x) => x !== 'durable-approvals') },
  'missing-ledger': { capabilities: CAPABILITIES.filter((x) => x !== 'operation-ledger') },
};
if (mode !== 'missing') {
  try {
    await bridge(
      'handshake',
      { ...manifest, ...mutations[mode] },
      mode === 'forged' ? 'x'.repeat(64) : c.token,
    );
  } catch {
    /* remain alive so the supervisor, not process exit, decides readiness */
  }
}
setInterval(() => {
  bridge('heartbeat').catch(() => {});
}, 100).unref();
