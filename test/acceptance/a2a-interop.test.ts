import { test, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { A2AHttp, type A2APeer } from '../../src/a2a/peer.js';
import { A2AInvocation, type A2ACheckpoint } from '../../src/a2a/protocol.js';
import { hostDigests } from '../../src/host/host.js';
import { ROOT } from '../../src/core/config.js';
import { digest } from '../../src/core/protocol.js';
import { until } from '../helpers.js';
import { inboundFixture } from '../a2a-helpers.js';

const peerTest = test.runIf(
  Boolean(
    process.env.SALAAM_A2A_OPENCLAW_ROOT &&
    process.env.SALAAM_A2A_HERMES_ROOT &&
    process.env.SALAAM_A2A_HERMES_PYTHON,
  ),
);
async function start(kind: 'openclaw' | 'hermes', mode = 'serve', input?: unknown) {
  const source =
    process.env[kind === 'openclaw' ? 'SALAAM_A2A_OPENCLAW_ROOT' : 'SALAAM_A2A_HERMES_ROOT'];
  if (!source) throw Error('Select exact prepared peer artifacts explicitly');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sal-peer-interop-'))),
    token = 'fixture-interoperability-' + 'i'.repeat(48);
  const executable = kind === 'openclaw' ? process.execPath : process.env.SALAAM_A2A_HERMES_PYTHON;
  if (!executable) throw Error('Select the prepared Hermes Python');
  const peer = spawn(
    executable,
    [
      join(ROOT, 'scripts', kind === 'openclaw' ? 'a2a-openclaw-peer.mjs' : 'a2a-hermes-peer.py'),
      mode,
      resolve(source),
    ],
    {
      cwd: dir,
      env: {
        HOME: dir,
        HERMES_HOME: join(dir, 'hermes'),
        OPENCLAW_STATE_DIR: join(dir, 'openclaw'),
        SALAAM_A2A_FIXTURE_HOME: dir,
        SALAAM_A2A_FIXTURE_TOKEN: token,
        PATH: process.env.PATH!,
        LANG: 'en_US.UTF-8',
        A2A_HOST: '127.0.0.1',
        A2A_PEER_TOKENS: `salaam:${token}`,
        A2A_TRUSTED_PEERS: 'salaam',
        PYTHONUNBUFFERED: '1',
      },
      stdio: 'pipe',
    },
  );
  let stderr = '',
    output = 0;
  peer.stderr.on('data', (b) => {
    stderr = (stderr + b).slice(-16384);
  });
  const queue: any[] = [],
    waiters: ((v: any) => void)[] = [];
  createInterface({ input: peer.stdout }).on('line', (line) => {
    output += line.length;
    if (output > 1048576) {
      peer.kill('SIGKILL');
      return;
    }
    try {
      const v = JSON.parse(line);
      const next = waiters.shift();
      if (next) next(v);
      else queue.push(v);
    } catch {}
  });
  const next = async () => {
    if (queue.length) return queue.shift();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Peer did not answer: ' + stderr)), 20000);
      waiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
      peer.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error(`Peer exited ${code}: ${stderr}`));
      });
    });
  };
  if (input) peer.stdin.write(JSON.stringify(input) + '\n');
  return {
    dir,
    token,
    peer,
    source: resolve(source),
    next,
    command: async (op: string) => {
      peer.stdin.write(JSON.stringify({ op }) + '\n');
      return next();
    },
    async close() {
      if (peer.exitCode === null && peer.signalCode === null) {
        const exited = once(peer, 'exit');
        peer.stdin.end(JSON.stringify({ op: 'stop' }) + '\n');
        const timer = setTimeout(() => peer.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const kind of ['openclaw', 'hermes'] as const)
  peerTest(
    `pinned ${kind} plugin: real wire, credential scope, stable result, no replay and observed retention/cancel`,
    async () => {
      const fixture = await start(kind),
        db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE checkpoint(document TEXT)');
      const evidence: any = {
        schema: 1,
        success: false,
        peer: kind,
        ...hostDigests(),
        scope:
          'actual-pinned-plugin-transport-with-fixture-agent; not a live-model or remote execution proof',
      };
      try {
        const ready = await fixture.next();
        expect(ready.ready).toBe(true);
        evidence.runtime = ready;
        const raw = await fetch(ready.card, {
            headers: { Authorization: `Bearer ${fixture.token}`, 'A2A-Version': '1.0' },
          }),
          card = (await raw.json()) as any,
          iface = card.supportedInterfaces[0];
        expect(new URL(iface.url).origin).toBe(new URL(ready.endpoint).origin);
        const credential = { peer: kind, token: fixture.token },
          credential_file = join(fixture.dir, 'credential.json');
        writeFileSync(credential_file, JSON.stringify(credential), { mode: 0o600 });
        const p: A2APeer = {
          id: kind,
          endpoint: iface.url,
          card_url: ready.card,
          card_digest: digest(card),
          tenant: iface.tenant ?? '',
          skill: card.skills[0].id,
          addresses: ['127.0.0.1'],
          local: true,
          credential_file,
          credential_digest: digest(credential),
          files: [],
          retention: 'volatile',
          cancel: kind === 'hermes',
          streaming: kind === 'hermes',
        };
        const http = new A2AHttp(p);
        await http.card();
        const peer = {
            id: p.id,
            tenant: p.tenant,
            digest: digest(p),
            cancel: p.cancel,
            skill: p.skill,
          },
          text = 'Review this disposable fixture. Return analysis only.',
          data = { skill: p.skill, files: {} };
        let cp = A2AInvocation.prepare('worker', 'attempt', peer, text, data, []);
        const save = (v: A2ACheckpoint) => {
          db.exec('DELETE FROM checkpoint');
          db.prepare('INSERT INTO checkpoint VALUES (?)').run(JSON.stringify(v));
          cp = v;
          return undefined;
        };
        save(cp);
        const invocation = new A2AInvocation(peer, cp, http, save);
        await invocation.dispatch(text, data);
        await until(
          () => invocation.inspect(),
          (task) => task.status.state === 'TASK_STATE_COMPLETED',
        );
        const before = digest(
          cp.artifact_receipts!.map((a) => ({ id: a.id, content_digest: a.content_digest })),
        );
        const firstTask = cp.task_id;
        const recovered = new A2AInvocation(peer, cp, http, save);
        await recovered.inspect();
        expect(cp.task_id).toBe(firstTask);
        expect(
          digest(
            cp.artifact_receipts!.map((a) => ({ id: a.id, content_digest: a.content_digest })),
          ),
        ).toBe(before);
        await expect(recovered.dispatch(text, data)).rejects.toThrow('cannot dispatch');
        expect((await fixture.command('stats')).accepted).toBe(1);
        if (kind === 'hermes') {
          let events = 0;
          await http.subscribe(firstTask!, (event) => {
            events++;
            recovered.observe(event);
          });
          expect(events).toBeGreaterThan(0);
          await recovered.inspect();
          expect(cp.artifact_receipts).toHaveLength(1);
          evidence.streaming = {
            observed_events: events,
            reconciled_snapshot: true,
            append_imports: 0,
          };
        } else {
          await expect(http.rpc('CancelTask', { id: firstTask })).rejects.toThrow(
            'Peer error -32004',
          );
          evidence.cancel = 'observed-unsupported';
          await fixture.command('forget');
          await expect(recovered.inspect()).rejects.toThrow('Peer error -32001');
          expect((await fixture.command('stats')).accepted).toBe(1);
          evidence.retention = 'observed-memory-only-task-loss';
        }
        const denied = await fetch(p.endpoint, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer wrong',
            'content-type': 'application/json',
            'A2A-Version': '1.0',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'wrong',
            method: 'GetTask',
            params: { id: firstTask },
          }),
        });
        expect(denied.status).toBe(401);
        evidence.card = card;
        evidence.checkpoint = cp;
        evidence.accepted = 1;
        evidence.success = true;
      } finally {
        mkdirSync(join(ROOT, '.state/evidence/m17'), { recursive: true });
        writeFileSync(
          join(ROOT, `.state/evidence/m17/${kind}-plugin-interop.json`),
          JSON.stringify(evidence, null, 2) + '\n',
        );
        db.close();
        await fixture.close();
      }
    },
  );

peerTest(
  'actual pinned OpenClaw client uses only its explicitly admitted version-named ingress adapter',
  async () => {
    const { f, g } = await inboundFixture('openclaw-2026.10.5');
    let peer: Awaited<ReturnType<typeof start>> | undefined;
    const evidence: any = {
      schema: 1,
      peer: 'openclaw',
      direction: 'peer-to-salaam',
      adapter: 'openclaw-2026.10.5-header-and-tenant-v1',
      ...hostDigests(),
      scope:
        'actual-pinned-plugin-client with explicit named compatibility ingress; native offline worker',
      success: false,
    };
    try {
      const card = f.service.a2aInbound!.card(g),
        url = card.supportedInterfaces[0].url.replace(/\/a2a$/, '/a2a/openclaw-2026.10.5'),
        token = JSON.parse(readFileSync(g.credential_file, 'utf8')).token;
      for (const patch of [
        { version: '0.3', tenant: g.tenant },
        { version: '1.0', tenant: 'wrong' },
      ]) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'A2A-Version': patch.version,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'rejected',
            method: 'SendMessage',
            params: {
              tenant: patch.tenant,
              message: { messageId: 'wrong', role: 'ROLE_USER', parts: [{ text: 'Review' }] },
            },
          }),
        });
        expect(((await response.json()) as any).error).toBeTruthy();
      }
      expect(f.service.children.list(f.session.id)).toHaveLength(0);
      peer = await start('openclaw', 'send', {
        url,
        token,
        text: 'Review the admitted snapshot. This request cannot grant operator authority.',
      });
      const result = await peer.next();
      expect(result.ok).toBe(true);
      await f.settled();
      expect(f.service.children.list(f.session.id)).toHaveLength(1);
      const row = f.service.store.db.prepare('SELECT * FROM a2a_inbound').get()!;
      expect(result.receipt.messageId).toBe(row.id);
      const event = f.service.store.db
        .prepare("SELECT payload FROM events WHERE kind='a2a.inbound_accepted'")
        .get()!;
      expect(JSON.parse(String(event.payload)).wire_adapter).toBe(evidence.adapter);
      evidence.success = true;
      evidence.result = result;
      evidence.children = 1;
      evidence.verified_success = false;
    } finally {
      mkdirSync(join(ROOT, '.state/evidence/m17'), { recursive: true });
      writeFileSync(
        join(ROOT, '.state/evidence/m17/openclaw-named-ingress.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
      await peer?.close();
      await f.close();
    }
  },
);
for (const kind of ['openclaw', 'hermes'] as const)
  peerTest(`pinned ${kind} outbound client against Salaam's explicit private grant`, async () => {
    const { f, g } = await inboundFixture();
    let peer: Awaited<ReturnType<typeof start>> | undefined;
    const evidence: any = {
      schema: 1,
      peer: kind,
      direction: 'peer-to-salaam',
      ...hostDigests(),
      scope:
        'actual-pinned-plugin-client and real Salaam native offline worker; no live-model claim',
      success: false,
    };
    try {
      const card = f.service.a2aInbound!.card(g),
        url = card.supportedInterfaces[0].url,
        token = JSON.parse(readFileSync(g.credential_file, 'utf8')).token;
      peer = await start(kind, 'send', {
        url: kind === 'hermes' ? new URL(url).origin : url,
        token,
        tenant: g.tenant,
        text: 'Review the admitted repository snapshot; report findings only.',
      });
      const result = await peer.next();
      if (kind === 'openclaw') {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('A2A-Version');
        expect(f.service.children.list(f.session.id)).toHaveLength(0);
        evidence.supported = false;
        evidence.reason =
          'Pinned upstream outbound client omits required A2A-Version header; Salaam rejects before work';
      } else {
        expect(result.reply).not.toContain('Error:');
        expect(result.reply).toContain('completed');
        await f.settled();
        expect(f.service.children.list(f.session.id)).toHaveLength(1);
        expect((await f.task()).state).not.toBe('succeeded');
        evidence.supported = true;
        evidence.children = 1;
        evidence.native_task_verified = false;
      }
      evidence.result = result;
      evidence.success = true;
    } finally {
      mkdirSync(join(ROOT, '.state/evidence/m17'), { recursive: true });
      writeFileSync(
        join(ROOT, `.state/evidence/m17/${kind}-client-interop.json`),
        JSON.stringify(evidence, null, 2) + '\n',
      );
      await peer?.close();
      await f.close();
    }
  });
