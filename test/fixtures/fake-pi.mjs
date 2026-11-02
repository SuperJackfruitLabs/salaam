import { call } from '../../dist/src/core/transport.js';
import {
  CAPABILITIES,
  workerCapabilities,
  textDigest,
  workerTools,
} from '../../dist/src/core/protocol.js';
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
    if (request.type === 'set_auto_retry' || request.type === 'set_auto_compaction') {
      process.stdout.write(
        JSON.stringify({
          type: 'response',
          id: request.id,
          success: mode !== 'missing-retry-control',
          error: 'Injected control unavailable',
        }) + '\n',
      );
    }
    if (request.type === 'get_state') {
      const args = process.argv.slice(2);
      const dir = args[args.indexOf('--session-dir') + 1];
      const state = {
        autoCompactionEnabled: false,
        sessionId: mode === 'wrong-state' ? 'wrong' : c.session,
        sessionFile: `${dir}/${c.session}.jsonl`,
        model: { provider: c.route.provider, id: c.route.model },
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
  capabilities: workerCapabilities(c.coding, c.worker_binding?.binding.tools),
  tools: workerTools(!!c.effects, !!c.child, c.coding, c.worker_binding?.binding.tools),
  active_tools: workerTools(!!c.effects, !!c.child, c.coding, c.worker_binding?.binding.tools),
  ...(c.coding ? { coding: c.coding } : {}),
  provider: c.route.provider,
  route: c.route,
  context_digest: textDigest(c.frame),
  ...(c.worker_binding ? { worker_binding: c.worker_binding } : {}),
};
const mutations = {
  'missing-coding-binding': { coding: null },
  'wrong-coding-profile': { coding: { ...c.coding, profile_digest: 'forged' } },
  'missing-file-capability': {
    capabilities: workerCapabilities(c.coding, c.worker_binding?.binding.tools).filter(
      (x) => x !== 'workspace-files',
    ),
  },
  'wrong-version': { protocol_version: 99 },
  'wrong-bundle': { bundle_digest: 'wrong' },
  'wrong-policy': { policy_digest: 'wrong' },
  'wrong-session': { pi_session_id: 'wrong' },
  'wrong-provider': { provider: 'anthropic' },
  'wrong-route': { route: { ...c.route, max_tokens: 777 } },
  'wrong-tools': { tools: ['salaam_probe', 'bypass'] },
  'missing-task-context': {
    capabilities: CAPABILITIES.filter((x) => x !== 'durable-task-context'),
  },
  'missing-compaction': { capabilities: CAPABILITIES.filter((x) => x !== 'managed-compaction') },
  'missing-context': { capabilities: ['persistent-session'] },
  'missing-approvals': { capabilities: CAPABILITIES.filter((x) => x !== 'durable-approvals') },
  'missing-children': { capabilities: CAPABILITIES.filter((x) => x !== 'child-work') },
  'missing-worker-boundary': {
    capabilities: CAPABILITIES.filter((x) => x !== 'worker-boundary-v1'),
  },
  'missing-usage': { capabilities: CAPABILITIES.filter((x) => x !== 'usage-ledger') },
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
