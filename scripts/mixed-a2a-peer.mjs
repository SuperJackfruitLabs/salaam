import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

// Independent acceptance peer. Its only model transport is the owning SSH/stdin
// channel. Provider credentials and network model endpoints never enter this host.
if (!process.argv.includes('--run'))
  throw Error('Use --run with a disposable acceptance configuration');
const file = process.argv[process.argv.indexOf('--config') + 1],
  config = JSON.parse(readFileSync(resolve(file), 'utf8'));
if (
  config.schema !== 1 ||
  config.host !== '127.0.0.1' ||
  !Number.isSafeInteger(config.port) ||
  config.port < 0 ||
  config.port > 65535 ||
  typeof config.token !== 'string' ||
  config.token.length < 32 ||
  typeof config.tenant !== 'string'
)
  throw Error('Invalid private acceptance peer configuration');
const sdkRoot = resolve(config.sdk),
  { Task, Message, AgentCard } = await import(pathToFileURL(join(sdkRoot, 'dist/index.js'))),
  { JsonRpcTransportHandler, ServerCallContext } = await import(
    pathToFileURL(join(sdkRoot, 'dist/server/index.js'))
  );
if (JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version !== '1.0.1')
  throw Error('Wrong independent A2A SDK');
mkdirSync(config.state, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(config.state, 'peer.sqlite'));
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,context_id TEXT NOT NULL,state TEXT NOT NULL,prompt TEXT NOT NULL,model_id TEXT NOT NULL UNIQUE,result TEXT,pending_result TEXT,barrier TEXT,created_at INTEGER NOT NULL);',
);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  emit = (value) => {
    const bytes = JSON.stringify(value) + '\n';
    if (bytes.length > 524288 || process.stdout.writableLength > 1048576)
      throw Error('Acceptance peer output bound');
    process.stdout.write(bytes);
  };
let stopped = false,
  nextBarrier = null,
  port;
function finish(id, text) {
  db.prepare(
    "UPDATE tasks SET state='TASK_STATE_COMPLETED',result=?,pending_result=NULL WHERE id=? AND state!='TASK_STATE_COMPLETED'",
  ).run(text, id);
}
// Reconcile a saved result, never replay an uncertain model call.
for (const row of db
  .prepare(
    "SELECT * FROM tasks WHERE state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED')",
  )
  .all()) {
  if (row.pending_result !== null) finish(row.id, row.pending_result);
  else
    db.prepare("UPDATE tasks SET state='TASK_STATE_FAILED',result=? WHERE id=?").run(
      'Peer restart interrupted the accepted analysis; no model request was resent',
      row.id,
    );
}
function snapshot(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) throw Error('Task not found');
  return {
    id: row.id,
    contextId: row.context_id,
    status: { state: row.state },
    artifacts:
      row.state === 'TASK_STATE_COMPLETED'
        ? [
            {
              artifactId: 'analysis-' + row.id,
              parts: [
                {
                  data: {
                    kind: 'analysis',
                    verified_success: false,
                    text: row.result,
                    input_digest: row.input_digest,
                    model: 'claude-sonnet-4-6',
                    tool_scope: 'none',
                  },
                },
              ],
            },
          ]
        : [],
    metadata: {
      outcome_unknown: row.state === 'TASK_STATE_FAILED',
      model_request_id: row.model_id,
    },
  };
}
function requestModel(row) {
  if (stopped) return;
  if (row.barrier === 'before_model') {
    emit({ kind: 'barrier', stage: 'before_model', task_id: row.id });
    return;
  }
  db.prepare(
    "UPDATE tasks SET state='TASK_STATE_WORKING' WHERE id=? AND state='TASK_STATE_SUBMITTED'",
  ).run(row.id);
  emit({
    kind: 'model_request',
    id: row.model_id,
    task_id: row.id,
    input_digest: row.input_digest,
    text: row.prompt,
  });
}
const handler = {
  async getAgentCard() {
    return AgentCard.fromJSON(card());
  },
  async sendMessage(params) {
    if (
      params.tenant !== config.tenant ||
      !params.message ||
      params.message.taskId ||
      params.message.contextId
    )
      throw Error('Only a fresh owned analysis invocation is supported');
    const wire = Message.toJSON(params.message),
      input_digest = hash(wire),
      old = db.prepare('SELECT * FROM tasks WHERE message_id=?').get(wire.messageId);
    if (old) {
      if (old.input_digest !== input_digest) throw Error('Message ID content conflict');
      return Task.fromJSON(snapshot(old.id));
    }
    if (
      db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE state IN ('TASK_STATE_SUBMITTED','TASK_STATE_WORKING')",
        )
        .get().n >= 2
    )
      throw Error('Peer concurrency bound');
    const prompt = JSON.stringify(wire.parts);
    if (prompt.length > 196608) throw Error('Peer input bound');
    const row = {
      id: randomUUID(),
      context_id: randomUUID(),
      model_id: randomUUID(),
      barrier: nextBarrier,
      prompt,
    };
    nextBarrier = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "INSERT INTO tasks VALUES (?,?,?,?, 'TASK_STATE_SUBMITTED',?,?,NULL,NULL,?,?)",
      ).run(
        row.id,
        wire.messageId,
        input_digest,
        row.context_id,
        prompt,
        row.model_id,
        row.barrier,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    queueMicrotask(() => requestModel({ ...row, input_digest }));
    return Task.fromJSON(snapshot(row.id));
  },
  async getTask(params) {
    if (params.tenant !== config.tenant) throw Error('Wrong tenant');
    return Task.fromJSON(snapshot(params.id));
  },
  async cancelTask() {
    throw Error('Cancellation unsupported; inspect the owned task');
  },
};
const transport = new JsonRpcTransportHandler(handler),
  server = createServer(async (req, res) => {
    try {
      const actual = Buffer.from(String(req.headers.authorization ?? '')),
        expected = Buffer.from('Bearer ' + config.token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(card()));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/a2a' || req.headers['a2a-version'] !== '1.0')
        throw Error('Unconfigured wire endpoint');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) throw Error('Peer request bound');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await transport.handle(
        body,
        new ServerCallContext({ requestedVersion: '1.0', tenant: config.tenant }),
      );
      res.writeHead(200, { 'content-type': 'application/json', 'A2A-Version': '1.0' });
      res.end(JSON.stringify(result));
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rejected independent acceptance request' }));
    }
  });
function card() {
  return AgentCard.toJSON(
    AgentCard.fromJSON({
      name: 'Independent mixed-runtime reviewer',
      description:
        'Private text/data analysis; provider relay and result recovery are acceptance-scoped',
      version: '1',
      supportedInterfaces: [
        {
          url: `http://127.0.0.1:${port}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
          tenant: config.tenant,
        },
      ],
      capabilities: { streaming: false },
      skills: [
        {
          id: 'review',
          name: 'Review',
          description: 'Review explicitly disclosed fixture files',
          tags: ['analysis'],
        },
      ],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['application/json'],
    }),
  );
}
await new Promise((resolve) => server.listen(config.port, config.host, resolve));
port = server.address().port;
emit({
  kind: 'ready',
  endpoint: `http://127.0.0.1:${port}/a2a`,
  card_url: `http://127.0.0.1:${port}/.well-known/agent-card.json`,
  sdk: '1.0.1',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  recovered_tasks: db.prepare('SELECT count(*) AS n FROM tasks').get().n,
});
async function stop() {
  if (stopped) return;
  stopped = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  try {
    if (line.length > 524288) throw Error('Peer control frame bound');
    const value = JSON.parse(line);
    if (value.op === 'model_response') {
      const row = db.prepare('SELECT * FROM tasks WHERE model_id=?').get(value.id);
      if (!row || ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'].includes(row.state)) return;
      if (value.error) {
        db.prepare("UPDATE tasks SET state='TASK_STATE_FAILED',result=? WHERE id=?").run(
          'Acceptance provider request failed; no verification claim',
          row.id,
        );
        emit({ kind: 'terminal', task_id: row.id, outcome_unknown: true });
        return;
      }
      if (typeof value.text !== 'string' || value.text.length > 131072)
        throw Error('Peer result bound');
      db.prepare('UPDATE tasks SET pending_result=? WHERE id=?').run(value.text, row.id);
      if (row.barrier === 'after_model') {
        emit({ kind: 'barrier', stage: 'after_model', task_id: row.id });
        return;
      }
      finish(row.id, value.text);
      emit({ kind: 'terminal', task_id: row.id, result_digest: hash(snapshot(row.id)) });
    } else if (value.op === 'arm_barrier') {
      if (!['before_model', 'after_model'].includes(value.stage)) throw Error('Unknown barrier');
      nextBarrier = value.stage;
      emit({ kind: 'armed', stage: nextBarrier });
    } else if (value.op === 'release') {
      const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(value.task_id);
      if (!row) throw Error('Unknown task');
      db.prepare('UPDATE tasks SET barrier=NULL WHERE id=?').run(row.id);
      if (row.pending_result !== null) finish(row.id, row.pending_result);
      else if (row.state === 'TASK_STATE_SUBMITTED') requestModel({ ...row, barrier: null });
    } else if (value.op === 'stats')
      emit({
        kind: 'stats',
        tasks: db
          .prepare(
            'SELECT id,message_id,context_id,state,model_id,pending_result IS NOT NULL AS saved_result FROM tasks',
          )
          .all(),
      });
    else if (value.op === 'stop') void stop();
    else throw Error('Unknown peer control operation');
  } catch (error) {
    emit({ kind: 'control_error', error: error.message });
    void stop();
  }
});
input.on('close', () => {
  void stop();
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void stop();
  });
