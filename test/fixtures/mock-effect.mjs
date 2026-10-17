// Independent, durable fixture for later effect-recovery proofs. No real effects.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson } from '../../dist/src/transport.js';
import { digest } from '../../dist/src/protocol.js';
const dir = process.argv[2];
const opaque = process.argv.includes('--opaque');
const db = new DatabaseSync(join(dir, 'effects.sqlite'));
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL)',
);
db.exec(
  "CREATE TABLE IF NOT EXISTS targets(target TEXT PRIMARY KEY,version INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS metrics(name TEXT PRIMARY KEY,n INTEGER NOT NULL);INSERT OR IGNORE INTO metrics VALUES ('posts',0),('lookups',0)",
);
const pending = new Map();
const before = new Map();
const socket = join(dir, 'effects.sock');
if (existsSync(socket)) unlinkSync(socket);
const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  try {
    if (req.method === 'POST' && req.url === '/effects') {
      db.prepare("UPDATE metrics SET n=n+1 WHERE name='posts'").run();
      const key = opaque ? randomUUID() : req.headers['idempotency-key'];
      const body = await readJson(req);
      if (typeof key !== 'string' || !key) {
        reply(400, { error: 'idempotency key required' });
        return;
      }
      const hash = digest(body);
      const accept = () => {
        let effect = db.prepare('SELECT * FROM effects WHERE key=?').get(key);
        if (effect && effect.hash !== hash) {
          reply(409, { error: 'key argument conflict' });
          return;
        }
        if (!effect) {
          const version = String(
            db.prepare('SELECT version FROM targets WHERE target=?').get(body.target)?.version ?? 1,
          );
          if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== version) {
            reply(412, { error: 'target version changed' });
            return;
          }
          const receipt = JSON.stringify({ id: key, accepted: true, payload: body });
          db.exec('BEGIN IMMEDIATE');
          db.prepare('INSERT INTO effects VALUES (?,?,?)').run(key, hash, receipt);
          if (req.headers['if-match'] !== undefined)
            db.prepare(
              'INSERT INTO targets VALUES (?,?) ON CONFLICT(target) DO UPDATE SET version=excluded.version',
            ).run(body.target, Number(version) + 1);
          db.exec('COMMIT');
          effect = { receipt };
        }
        // Acceptance is durable before this barrier, including when killed here.
        if (
          req.headers['x-hold-after-accept'] === 'true' ||
          existsSync(join(dir, 'hold-response'))
        ) {
          writeFileSync(join(dir, 'accepted'), key);
          pending.set(key, () => reply(200, JSON.parse(effect.receipt)));
          return;
        }
        reply(200, JSON.parse(effect.receipt));
      };
      if (existsSync(join(dir, 'hold-before-accept'))) {
        writeFileSync(join(dir, 'before-accept'), key);
        before.set(key, accept);
        return;
      }
      accept();
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/effects/')) {
      const key = decodeURIComponent(req.url.slice('/effects/'.length));
      db.prepare("UPDATE metrics SET n=n+1 WHERE name='lookups'").run();
      if (opaque || existsSync(join(dir, 'lookup-unavailable'))) {
        reply(503, { error: 'lookup unavailable' });
        return;
      }
      const row = db.prepare('SELECT receipt FROM effects WHERE key=?').get(key);
      const receipt = row ? JSON.parse(row.receipt) : null;
      if (receipt && existsSync(join(dir, 'tamper-lookup')))
        receipt.payload.target = 'tampered-target';
      reply(row ? 200 : 404, receipt ?? { error: 'not found' });
      return;
    }
    if (req.method === 'GET' && req.url === '/stats') {
      reply(200, {
        count: db.prepare('SELECT count(*) AS n FROM effects').get().n,
        posts: db.prepare("SELECT n FROM metrics WHERE name='posts'").get().n,
        lookups: db.prepare("SELECT n FROM metrics WHERE name='lookups'").get().n,
        effects: db
          .prepare('SELECT receipt FROM effects')
          .all()
          .map((row) => JSON.parse(row.receipt)),
      });
      return;
    }
    if (req.url.startsWith('/targets/')) {
      const target = decodeURIComponent(req.url.slice('/targets/'.length));
      if (req.method === 'POST') {
        const body = await readJson(req);
        db.prepare(
          'INSERT INTO targets VALUES (?,?) ON CONFLICT(target) DO UPDATE SET version=excluded.version',
        ).run(target, Number(body.version));
      }
      reply(200, {
        version: String(
          db.prepare('SELECT version FROM targets WHERE target=?').get(target)?.version ?? 1,
        ),
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/release-all') {
      for (const release of before.values()) release();
      before.clear();
      for (const release of pending.values()) release();
      pending.clear();
      reply(200, { released: true });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/release/')) {
      const key = decodeURIComponent(req.url.slice('/release/'.length));
      before.get(key)?.();
      before.delete(key);
      pending.get(key)?.();
      pending.delete(key);
      reply(200, { released: true });
      return;
    }
    reply(404, { error: 'not found' });
  } catch {
    reply(500, { error: 'fixture failure' });
  }
});
server.listen(socket, () => console.log(JSON.stringify({ socket })));
process.on('SIGTERM', () => {
  server.close();
  server.closeAllConnections();
  db.close();
});
