import { expect, test } from 'vitest';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fixture, create, ready, until } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { PtyClient } from '../terminal-helpers.js';
import { call } from '../../src/transport.js';
import type { SessionSnapshot } from '../../src/protocol.js';
import { OperatorClient } from '../../src/tui-client.js';

test('an observer frame can precede its held snapshot without approving unseen work', async () => {
  const f = await fixture(),
    writer = new OperatorClient(f.dir);
  const state = join(f.dir, 'snapshot-client');
  mkdirSync(state);
  let terminal: PtyClient | undefined,
    release!: () => void,
    snapshotHeld = false;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const upstreams = new Set<ReturnType<typeof request>>();
  const proxy = createServer(async (req, res) => {
    if (!snapshotHeld && req.method === 'GET' && req.url?.endsWith('/snapshot')) {
      snapshotHeld = true;
      await gate;
    }
    if (res.destroyed) return;
    const upstream = request(
      {
        socketPath: f.service.socket,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: false,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 500, reply.headers);
        reply.pipe(res);
      },
    );
    upstreams.add(upstream);
    upstream.on('error', () => res.destroy());
    res.once('close', () => {
      upstreams.delete(upstream);
      upstream.destroy();
    });
    req.pipe(upstream);
  });
  try {
    await new Promise<void>((done) => proxy.listen(join(state, 'operator.sock'), done));
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await writer.open(session.id);
    await writer.submit('[review] snapshot-boundary');
    await until(
      () => f.service.store.approvals(session.id),
      (rows) => rows.filter((a) => a.state === 'pending').length === 1,
    );
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--observe', '--state', state],
      { state, columns: 116, rows: 40 },
    );
    await terminal.contains('Observer');
    await until(() => snapshotHeld, Boolean);
    // Exactly the early frame seen by the failed Linux acceptance run. The
    // observer label is visible while the actual approval snapshot is held.
    await terminal.write('\x0f');
    await terminal.contains('No approvals are waiting.');
    expect((await terminal.screen()).includes('Review approval')).toBe(false);
    expect(f.service.store.approvals(session.id)[0]?.state).toBe('pending');
    expect(f.service.store.controlView(session.id).client_id).toBe(writer.clientId);
    await terminal.command({ op: 'signal', signal: 'SIGKILL', target: 'process' });
    await terminal.exit();
    terminal = undefined;
  } finally {
    release();
    await terminal?.close();
    for (const upstream of upstreams) upstream.destroy();
    await new Promise<void>((done) => proxy.close(() => done()));
    await writer.close();
    await f.close();
  }
}, 30000);

test('real PTY opens Salaam, preserves Unicode multiline paste, resizes and restores the terminal on detach', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--state', f.dir],
      { state: f.dir, columns: 116, rows: 38 },
    );
    await terminal.contains('S A L A A M');
    await terminal.contains('You have control');
    const prompt = 'Salaam 🌿\nनमस्ते — keep one session';
    await terminal.write('\x1b[200~' + prompt + '\x1b[201~');
    await terminal.resize(72, 28);
    await terminal.contains('Salaam 🌿');
    expect(f.service.store.snapshot(session.id).submissions).toHaveLength(0);
    await terminal.write('\r');
    const final = await until(
      () => f.service.store.snapshot(session.id),
      (view) => view.attempts[0]?.state === 'completed',
    );
    expect(final.submissions).toHaveLength(1);
    expect(final.submissions[0]!.text).toBe(prompt);
    await terminal.contains('Offline reply:');
    if (process.env.SALAAM_TUI_CAPTURE_DIR) {
      mkdirSync(process.env.SALAAM_TUI_CAPTURE_DIR, { recursive: true });
      await terminal.capture(join(process.env.SALAAM_TUI_CAPTURE_DIR, 'night-conversation.svg'));
    }
    await terminal.write('\x03');
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
    expect(f.service.supervisor.inspect(session.id).state).toBe('ready');
    const raw = Buffer.concat(terminal.captured).toString();
    expect(raw).toContain('\x1b[?1049l');
    expect(raw).toContain('\x1b[?2004l');
    expect(raw).toContain('Detached from Salaam');
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);

test('hard terminal loss, observer reconnect and explicit TUI takeover preserve one real tool turn', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  let first: PtyClient | undefined, second: PtyClient | undefined;
  try {
    const session = await create(f.service, f.dir),
      original = await ready(f.service, session.id);
    first = new PtyClient([join(ROOT, 'bin/salaam.mjs'), 'attach', session.id, '--state', f.dir], {
      state: f.dir,
      columns: 116,
      rows: 38,
    });
    await first.contains('You have control');
    await first.write('Keep one running turn\r');
    const { existsSync } = await import('node:fs');
    await until(() => existsSync(join(f.dir, 'probe-entered')), Boolean);
    const attempt = f.service.store.snapshot(session.id).attempts[0]!;
    await first.command({ op: 'signal', signal: 'SIGKILL' });
    await first.exit();
    expect(f.service.store.attempt(attempt.id).state).toBe('running');
    second = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--observe', '--state', f.dir],
      { state: f.dir, columns: 116, rows: 38 },
    );
    await second.contains('Observer');
    await second.write('\x0b');
    await second.contains('Salaam · actions');
    await second.write('Take control\r');
    await second.contains('Keep current state');
    await second.write('\x1b[C\r');
    await second.contains('You have control');
    expect(f.service.store.controlView(session.id).epoch).toBeGreaterThan(1);
    writeFileSync(join(f.dir, 'release-probe'), 'go');
    await second.contains('Offline reply: Keep one running turn');
    expect(f.service.store.snapshot(session.id).attempts).toHaveLength(1);
    expect(f.service.store.attempt(attempt.id).state).toBe('completed');
    expect(f.service.supervisor.inspect(session.id).epoch).toBe(original.epoch);
    await second.write('\x03');
    expect((await second.exit()).restored).toBe(true);
  } finally {
    await first?.close();
    await second?.close();
    await f.close();
  }
}, 30000);

test('a running turn shows a live progress line that counts seconds and says esc interrupts', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  let terminal: PtyClient | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'attach', session.id, '--state', f.dir],
      {
        state: f.dir,
        columns: 116,
        rows: 38,
      },
    );
    await terminal.contains('You have control');
    await terminal.write('Keep one running turn\r');
    const { existsSync } = await import('node:fs');
    await until(() => existsSync(join(f.dir, 'probe-entered')), Boolean);
    await terminal.contains('esc to interrupt');
    // Trial polish #8: the line keeps counting on its own, with no input and no refresh.
    const seconds = (screen: string) => Number(/… · (\d+)s · /.exec(screen)?.[1] ?? -1);
    const first = await until(
      () => terminal!.screen(),
      (screen) => seconds(screen) >= 0,
    );
    await until(
      () => terminal!.screen(),
      (screen) => seconds(screen) >= seconds(first) + 2,
    );
    writeFileSync(join(f.dir, 'release-probe'), 'go');
    await terminal.contains('Offline reply: Keep one running turn');
    await until(
      () => terminal!.screen(),
      (screen) => !screen.includes('esc to interrupt'),
    );
    await terminal.write('\x03');
    expect((await terminal.exit()).restored).toBe(true);
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);

test('TUI reviews two operation-bound approvals in reverse order and observer decisions do not take control', async () => {
  const f = await fixture();
  let writer: PtyClient | undefined, observer: PtyClient | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    writer = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--state', f.dir],
      { state: f.dir, columns: 116, rows: 40 },
    );
    await writer.contains('You have control');
    await writer.write('[review] alpha,beta\r');
    await until(
      () => f.service.store.approvals(session.id),
      (approvals) => approvals.filter((a) => a.state === 'pending').length === 2,
    );
    const activity = await call<{ kind: string; payload: { parent_tool_call_id?: string } }[]>(
      f.service.socket,
      `/v1/sessions/${session.id}/activity`,
    );
    expect(
      activity.filter(
        (event) => event.kind === 'tool.started' && event.payload.parent_tool_call_id,
      ),
    ).toHaveLength(2);
    const owner = f.service.store.controlView(session.id).client_id;
    observer = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--observe', '--state', f.dir],
      { state: f.dir, columns: 116, rows: 40 },
    );
    await observer.contains('Observer');
    // Observer mode renders before the first snapshot has loaded its approvals.
    await observer.contains('2 approvals waiting');
    await observer.write('\x0f');
    await observer.contains('Approvals waiting');
    await observer.write('beta\r');
    await observer.contains('Approve?');
    await observer.write('\x1b[F');
    // Reading to the end lifts the read-to-the-end gate before approving.
    await until(
      () => observer!.screen(),
      (screen) => screen.includes('Approve once') && !screen.includes('Read to the end'),
    );
    if (process.env.SALAAM_TUI_CAPTURE_DIR)
      await observer.capture(join(process.env.SALAAM_TUI_CAPTURE_DIR, 'approval.svg'));
    // Focus opens on Approve once (trial polish #2).
    await observer.write('\r');
    await until(
      () => f.service.store.approvals(session.id),
      (approvals) => approvals.some((a) => a.decision === 'approve'),
    );
    await observer.write('\x0f');
    await observer.contains('Approve?');
    await observer.write('n');
    await until(
      () => f.service.store.snapshot(session.id),
      (snapshot) => snapshot.attempts[0]?.state === 'completed',
    );
    expect(
      f.service.store
        .approvals(session.id)
        .map((a) => a.decision)
        .sort(),
    ).toEqual(['approve', 'deny']);
    expect(f.service.store.controlView(session.id).client_id).toBe(owner);
    expect(f.service.store.operations(session.id).find((op) => op.target === 'beta')?.state).toBe(
      'succeeded',
    );
    expect(f.service.store.operations(session.id).find((op) => op.target === 'alpha')?.state).toBe(
      'cancelled_before_dispatch',
    );
  } finally {
    await writer?.close();
    await observer?.close();
    await f.close();
  }
}, 30000);

test('NO_COLOR and a narrow terminal remain usable and SIGTERM restores modes without stopping the daemon', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient([join(ROOT, 'bin/salaam.mjs'), '--state', f.dir], {
      state: f.dir,
      columns: 62,
      rows: 26,
      env: { NO_COLOR: '1' },
    });
    await terminal.contains('Your Salaam sessions');
    await terminal.write(shortIdForTest(session.id) + '\r');
    await terminal.contains('Ask Salaam');
    await terminal.command({ op: 'signal', signal: 'SIGTERM' });
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
    expect(Buffer.concat(terminal.captured).toString()).not.toContain('\x1b[38;2;');
    expect(f.service.supervisor.inspect(session.id).state).toBe('ready');
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);
function shortIdForTest(id: string): string {
  return id.slice(0, 8);
}

test('external prompt editor runs in cooked mode, returns exact input and resumes the branded TUI', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  try {
    const editor = join(f.dir, 'editor.mjs'),
      gate = join(f.dir, 'editor-entered'),
      release = join(f.dir, 'editor-release');
    writeFileSync(
      editor,
      `import{writeFileSync,existsSync}from'node:fs';writeFileSync(${JSON.stringify(gate)},'entered');const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);writeFileSync(process.argv.at(-1),'Edited prompt 🌿\\nsecond line');}},20);`,
    );
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--state', f.dir],
      { state: f.dir, env: { EDITOR: process.execPath + ' ' + editor } },
    );
    await terminal.contains('You have control');
    await terminal.write('\x05');
    const { existsSync } = await import('node:fs');
    await until(() => existsSync(gate), Boolean);
    expect((await terminal.command({ op: 'status' })).raw).toBe(false);
    writeFileSync(release, 'go');
    await terminal.contains('Edited prompt 🌿');
    expect((await terminal.command({ op: 'status' })).raw).toBe(true);
    await terminal.write('\r');
    await until(
      () => f.service.store.snapshot(session.id),
      (snapshot) => snapshot.attempts[0]?.state === 'completed',
    );
    expect(f.service.store.snapshot(session.id).submissions[0]?.text).toBe(
      'Edited prompt 🌿\nsecond line',
    );
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);

test('slow terminal output recovers a complete fresh frame and still accepts one instruction', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--state', f.dir],
      { state: f.dir, columns: 280, rows: 90 },
    );
    await terminal.contains('You have control');
    await terminal.command({ op: 'pause', paused: true });
    for (let n = 0; n < 70; n++) {
      await terminal.resize(279 + (n % 2), 89 + (n % 2));
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    await terminal.resize(116, 38);
    await terminal.command({ op: 'pause', paused: false });
    await terminal.contains('S A L A A M');
    await terminal.write('After slow output\r');
    await until(
      () => f.service.store.snapshot(session.id),
      (snapshot) => snapshot.attempts[0]?.state === 'completed',
    );
    expect(f.service.store.snapshot(session.id).submissions).toHaveLength(1);
    await terminal.contains('Offline reply: After slow output');
    await terminal.write('\x03');
    expect((await terminal.exit()).restored).toBe(true);
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);

test('terminating only the remote launcher forwards the signal so its SSH child restores the terminal', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  try {
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const child = join(f.dir, 'ssh-child.mjs');
    writeFileSync(
      child,
      "process.stdin.setRawMode(true);process.stdin.resume();console.log('fixture-ssh-ready');process.once('SIGTERM',()=>{process.stdin.setRawMode(false);process.exit(0);});setInterval(()=>{},1000);",
    );
    writeFileSync(
      join(bin, 'ssh'),
      '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(child) + '\n',
      { mode: 0o700 },
    );
    terminal = new PtyClient([join(ROOT, 'bin/salaam.mjs'), 'remote', 'fixture'], {
      state: f.dir,
      env: { PATH: bin + ':' + process.env.PATH },
    });
    await terminal.contains('fixture-ssh-ready');
    expect((await terminal.command({ op: 'status' })).raw).toBe(true);
    await terminal.command({ op: 'signal', signal: 'SIGTERM', target: 'process' });
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);

test('terminating the TUI while an external editor is open cleans up that editor and leaves terminal modes restored', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  try {
    const editor = join(f.dir, 'editor-held.mjs'),
      gate = join(f.dir, 'editor-open');
    writeFileSync(
      editor,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(gate)},String(process.pid));setInterval(()=>{},1000);`,
    );
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--state', f.dir],
      { state: f.dir, env: { EDITOR: process.execPath + ' ' + editor } },
    );
    await terminal.contains('You have control');
    await terminal.write('\x05');
    const { existsSync } = await import('node:fs');
    await until(() => existsSync(gate), Boolean);
    const editorPid = Number(readFileSync(gate, 'utf8'));
    await terminal.command({ op: 'signal', signal: 'SIGTERM', target: 'process' });
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
    expect(() => process.kill(editorPid, 0)).toThrow();
    expect(f.service.supervisor.inspect(session.id).state).toBe('ready');
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);

test('TUI preserves M8 daemon compatibility when health and coding routes lack M9 fields', async () => {
  const f = await fixture();
  let terminal: PtyClient | undefined;
  const clientState = join(f.dir, 'legacy-client');
  mkdirSync(clientState);
  const upstreams = new Set<ReturnType<typeof request>>();
  const proxy = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          service: 'salaam',
          provider_route: { provider: 'salaam-proof', model: 'scripted', max_tokens: 1024 },
          effect_connector: false,
          sessions: 1,
        }),
      );
      return;
    }
    if (/\/(activity|workspace|commands)(\?|$)/.test(req.url ?? '')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'not_found', error: 'Unknown route' }));
      return;
    }
    const upstream = request(
      {
        socketPath: f.service.socket,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: false,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 500, reply.headers);
        reply.pipe(res);
      },
    );
    upstreams.add(upstream);
    upstream.on('error', () => res.destroy());
    res.once('close', () => {
      upstreams.delete(upstream);
      upstream.destroy();
    });
    req.pipe(upstream);
  });
  try {
    await new Promise<void>((resolve) => proxy.listen(join(clientState, 'operator.sock'), resolve));
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        session.id,
        '--observe',
        '--state',
        clientState,
      ],
      { state: clientState, columns: 116, rows: 38 },
    );
    await terminal.contains('Observer');
    await terminal.write('\x14');
    await terminal.contains('Command execution is off');
    await terminal.write('\t');
    await terminal.contains('SESSION CONTEXT');
    await terminal.write('\x03');
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
    expect(f.service.store.snapshot(session.id).submissions).toHaveLength(0);
  } finally {
    await terminal?.close();
    for (const req of upstreams) req.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.close();
  }
}, 30000);

test('slash completion, help and model selection work in a real terminal without becoming model prompts', async () => {
  const f = await fixture();
  const client = new OperatorClient(f.dir);
  let terminal: PtyClient | undefined;
  try {
    const id = await client.create(f.dir, false);
    await ready(f.service, id);
    await client.close();
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', id, '--state', f.dir],
      { state: f.dir, columns: 116, rows: 40 },
    );
    await terminal.contains('You have control');
    await terminal.write('\x1b[200~/help\x1b[201~\r');
    await terminal.contains('Salaam commands');
    await terminal.write('\x1b');
    await until(
      () => terminal!.screen(),
      (screen) => !screen.includes('Salaam commands'),
    );
    await terminal.write('/mod');
    await terminal.contains('Switch this session’s provider and model');
    await terminal.write('\t');
    await terminal.write('\r');
    // Phase 2d: /model switches the open session in place; it does not start another.
    await terminal.contains('Provider · switches this session');
    await terminal.write('offline\r');
    await terminal.contains('in this session.');
    // The proof fixture prepares every route as its scripted one, so assert the switch itself.
    await until(
      () => f.service.store.events(id, 0),
      (events) => events.some((e) => e.kind === 'provider.route_changed'),
    );
    expect(f.service.store.sessions()).toHaveLength(1);
    for (const session of f.service.store.sessions()) {
      expect(f.service.store.snapshot(session.id).submissions).toHaveLength(0);
      expect(f.service.store.events(session.id, 0).some((e) => e.kind === 'model.admitted')).toBe(
        false,
      );
    }
  } finally {
    await terminal?.close();
    await client.close();
    await f.close();
  }
}, 30000);
