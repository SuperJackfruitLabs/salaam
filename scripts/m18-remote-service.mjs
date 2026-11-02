import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { providerFetch } from './m18-provider-fetch.mjs';

// Trusted acceptance host adapter. The actual key remains at the other end of
// the owning SSH channel; every real API request is admitted there before fetch.
if (!process.argv.includes('--run'))
  throw Error('Use --run with a disposable reviewed configuration');
const config = JSON.parse(
  readFileSync(resolve(process.argv[process.argv.indexOf('--config') + 1]), 'utf8'),
);
if (
  !/^\/home\/hermes\/\.cache\/salaam-m10\.eByB1aeQ\/m18-[0-9a-f-]{36}$/.test(config.root) ||
  process.env.HOME !== join(config.root, 'service-home') ||
  config.model !== 'claude-sonnet-4-6'
)
  throw Error('Unowned acceptance configuration');
if (
  resolve(config.package_root) !== join(config.root, 'cli/node_modules/@superjackfruitlabs/salaam')
)
  throw Error('Unowned installed package');
const pkg = resolve(config.package_root),
  socket = join(config.root, 'provider.sock'),
  pending = new Map();
let service,
  stopping = false;
const emit = (value) => {
  const frame = JSON.stringify(value) + '\n';
  if (frame.length > 4194304 || process.stdout.writableLength > 4194304)
    throw Error('Acceptance control backpressure');
  process.stdout.write(frame);
};
if (existsSync(socket)) {
  const stat = lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid())
    throw Error('Provider socket owner changed');
  unlinkSync(socket);
}
const gateway = createServer(async (req, res) => {
  try {
    if (stopping || req.method !== 'POST' || req.url !== '/messages' || pending.size >= 8)
      throw Error('Provider relay unavailable');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 3145728) throw Error('Provider frame bound');
      chunks.push(Buffer.from(chunk));
    }
    const frame = JSON.parse(Buffer.concat(chunks).toString('utf8')),
      id = randomUUID();
    pending.set(id, res);
    res.on('close', () => {
      if (pending.delete(id)) emit({ kind: 'model_cancel', id });
    });
    emit({
      kind: 'model_request',
      id,
      method: frame.method,
      path: frame.path,
      headers: frame.headers,
      body: frame.body,
    });
  } catch {
    res.destroy();
  }
});
await new Promise((resolve) => gateway.listen(socket, resolve));
chmodSync(socket, 0o600);
globalThis.fetch = providerFetch(socket);
const { SalaamService } = await import(pathToFileURL(join(pkg, 'dist/src/service/service.js'))),
  { PiProcess } = await import(pathToFileURL(join(pkg, 'dist/src/runtime/pi.js'))),
  { providerRoute } = await import(pathToFileURL(join(pkg, 'dist/src/providers/config.js'))),
  { ProviderCredentialStore } = await import(
    pathToFileURL(join(pkg, 'dist/src/providers/auth.js'))
  ),
  { call } = await import(pathToFileURL(join(pkg, 'dist/src/core/transport.js'))),
  { hostDigests } = await import(pathToFileURL(join(pkg, 'dist/src/core/config.js')));
const { HarnessProtocol } = await import(pathToFileURL(join(pkg, 'dist/src/harness/protocol.js')));
const originalPermission = HarnessProtocol.prototype.permission;
HarnessProtocol.prototype.permission = async function (method, params) {
  emit({ kind: 'harness_permission_observed', method, params });
  return originalPermission.call(this, method, params);
};
const credentials = new ProviderCredentialStore();
const { readTree } = await import(pathToFileURL(join(pkg, 'dist/src/coding/workspaces.js')));
await credentials.modify('anthropic', async () => ({ type: 'api_key', key: config.proxy_token }));
const input = createInterface({ input: process.stdin });
async function close() {
  if (stopping) return;
  stopping = true;
  await service?.close();
  for (const res of pending.values()) res.destroy();
  pending.clear();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
}
input.on('line', (line) => {
  void (async () => {
    try {
      if (line.length > 4194304) throw Error('Acceptance input bound');
      const value = JSON.parse(line);
      if (value.op === 'model_response') {
        const res = pending.get(value.id);
        if (!res) return;
        if (value.status !== undefined)
          res.writeHead(value.status, { 'content-type': value.content_type ?? 'application/json' });
        if (value.chunk) res.write(Buffer.from(value.chunk, 'base64'));
        if (value.end) {
          pending.delete(value.id);
          res.end();
        }
      } else if (value.op === 'api') {
        if (!service || !value.path.startsWith('/v1/')) throw Error('Unconfigured operator API');
        const result = await call(service.socket, value.path, value.body, undefined, 120000);
        emit({ kind: 'reply', id: value.id, result });
      } else if (value.op === 'saved_peer_run') {
        const task = service.taskWork.get(value.task),
          assignment = service.team.get(value.assignment);
        if (
          service.store.session(task.session_id).cwd !== join(config.root, 'source') ||
          assignment.task_id !== task.id ||
          service.external.assignment(assignment.id)?.kind !== 'a2a' ||
          !/^mixed-runtime-[0-9a-f-]{36}:peer-review-once$/.test(value.request_id)
        )
          throw Error('Not an owned peer run');
        const saved = service.store.db
          .prepare('SELECT hash,response FROM requests WHERE actor=? AND id=?')
          .get('local-operator', value.request_id);
        if (!saved) throw Error('No saved owned request');
        const { digest } = await import(pathToFileURL(join(pkg, 'dist/src/core/protocol.js')));
        let body;
        for (let expected = 0; expected <= Math.min(task.revision, 1024); expected++)
          if (
            digest({
              kind: 'team-run',
              id: assignment.id,
              expected,
              generation: 0,
              instruction: null,
              continuation: null,
            }) === saved.hash
          )
            body = { request_id: value.request_id, expected_revision: expected, generation: 0 };
        if (!body) throw Error('Saved request fingerprint differs');
        emit({ kind: 'reply', id: value.id, result: { body, result: JSON.parse(saved.response) } });
      } else if (value.op === 'evidence') {
        const session = service.store.session(value.session);
        if (session.cwd !== join(config.root, 'source'))
          throw Error('Audit only the owned fixture source');
        const children = service.children.list(session.id).map((child) => {
          const report = service.store.db
            .prepare('SELECT artifact_id FROM specialist_reports WHERE worker_id=?')
            .get(child.worker.binding.worker_id);
          return {
            child,
            result: child.result_id
              ? service.children.consume(session.id, child.id, child.result_id)
              : null,
            findings: report ? JSON.parse(service.artifacts.read(report.artifact_id)) : null,
            reads: Number(
              service.store.db
                .prepare(
                  "SELECT count(*) AS n FROM events WHERE session_id=? AND kind='specialist.read'",
                )
                .get(child.child_session).n,
            ),
          };
        });
        emit({
          kind: 'reply',
          id: value.id,
          result: {
            children,
            workspace: service.workspaces.inspect(session.id),
            tree: readTree(service.workspaces.verify(session.id).root),
            source: readTree(session.cwd, true),
            workers: service.store.db.prepare('SELECT session_id,epoch,state FROM workers').all(),
            task: service.taskWork.forSession(session.id)
              ? service.taskDriver.view(service.taskWork.forSession(session.id).id)
              : null,
            approvals: service.managed.pending(),
            commands: service.coding.list(session.id),
          },
        });
      } else if (value.op === 'snapshot')
        emit({
          kind: 'reply',
          id: value.id,
          result: {
            health: await call(service.socket, '/v1/health'),
            sessions: service.store.sessions(),
            ...hostDigests(),
          },
        });
      else if (value.op === 'close') {
        await close();
        emit({ kind: 'closed' });
        input.close();
      } else throw Error('Unknown acceptance command');
    } catch (error) {
      let id = null;
      try {
        id = JSON.parse(line).id ?? null;
      } catch {}
      emit({ kind: 'reply', id, error: error.message });
    }
  })();
});
input.on('close', () => {
  void close();
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close();
  });
service = await SalaamService.open({
  stateDir: join(config.root, 's'),
  codingRoot: join(config.root, 'owned'),
  codingSocket: '/var/run/docker.sock',
  harnessConfig: join(config.root, 'harness.json'),
  a2aConfig: join(config.root, 'peers.json'),
  providerRoute: providerRoute('anthropic', config.model, 4096),
  providerEnvironment: {},
  providerCredentials: credentials,
  anthropicApiKey: config.proxy_token,
  launch: (launch) =>
    new PiProcess(
      launch.command,
      [
        '--import',
        pathToFileURL(join(config.root, 'uploads/m18-provider-preload.mjs')).href,
        ...launch.args,
      ],
      launch.cwd,
      { ...launch.env, SALAAM_ACCEPTANCE_PROVIDER_SOCKET: socket },
    ),
});
emit({
  kind: 'ready',
  pid: process.pid,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  state: service.stateDir,
  provider_transport: 'bounded-SSH-stdio-acceptance-relay-no-real-key-on-host',
  provider_preload: join(config.root, 'uploads/m18-provider-preload.mjs'),
  acceptance_adapters: Object.fromEntries(
    ['m18-remote-service.mjs', 'm18-provider-preload.mjs', 'm18-provider-fetch.mjs'].map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(config.root, 'uploads', name)))
        .digest('hex'),
    ]),
  ),
  ...hostDigests(),
});
