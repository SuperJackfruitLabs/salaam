// Independent, durable fixture for later effect-recovery proofs. No real effects.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../dist/src/transport.js';
import { digest } from '../../dist/src/protocol.js';
const dir = process.argv[2];
const db = new DatabaseSync(join(dir, 'effects.sqlite'));
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL)',
);
const pending = new Map();
const socket = join(dir, 'effects.sock');
if (existsSync(socket)) unlinkSync(socket);
const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  try {
    if (req.method === 'POST' && req.url === '/effects') {
      const key = req.headers['idempotency-key'];
      const body = await readJson(req);
      if (typeof key !== 'string' || !key) {
        reply(400, { error: 'idempotency key required' });
        return;
      }
      const hash = digest(body);
      let effect = db.prepare('SELECT * FROM effects WHERE key=?').get(key);
      if (effect && effect.hash !== hash) {
        reply(409, { error: 'key argument conflict' });
        return;
      }
      if (!effect) {
        const receipt = JSON.stringify({ id: key, accepted: true, payload: body });
        db.prepare('INSERT INTO effects VALUES (?,?,?)').run(key, hash, receipt);
        effect = { receipt };
      }
      // Acceptance is durable before this barrier, including when killed here.
      if (req.headers['x-hold-after-accept'] === 'true') {
        pending.set(key, () => reply(200, JSON.parse(effect.receipt)));
        return;
      }
      reply(200, JSON.parse(effect.receipt));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/effects/')) {
      const key = decodeURIComponent(req.url.slice('/effects/'.length));
      const row = db.prepare('SELECT receipt FROM effects WHERE key=?').get(key);
      reply(row ? 200 : 404, row ? JSON.parse(row.receipt) : { error: 'not found' });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/release/')) {
      const key = decodeURIComponent(req.url.slice('/release/'.length));
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
