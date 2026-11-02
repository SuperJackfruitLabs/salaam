import { expect, test } from 'vitest';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import {
  BrokerRelay,
  inSandboxRelaySource,
  COMMAND_NETWORK_PORT,
} from '../../src/local/command-network.js';
import { sandboxArgv, seatbeltProfile } from '../../src/local/command-sandbox.js';
import { fakeBroker, helloServer } from '../helpers/fake-broker.js';

// Network allowlist for local commands (operator rulings 2026-10-30): the command reaches the
// network only through stk's local-commands socket; Salaam's host-side relay is what forwards and
// counts, so a command cannot forge its own connection summary.

function request(relay: { connect(): ReturnType<typeof connect> }, line: string): Promise<string> {
  return new Promise((resolve) => {
    const s = relay.connect();
    let out = '';
    s.on('data', (d) => {
      out += d.toString();
      if (out.includes('\r\n\r\n') && out.startsWith('HTTP/1.1 200')) {
        s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
      }
    });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(line + '\r\nHost: x\r\n\r\n');
  });
}

test('the relay forwards an allowed CONNECT through the broker and counts it', async () => {
  const up = await helloServer();
  const broker = await fakeBroker('allowed.test', up.port);
  const relay = await BrokerRelay.start(broker.socket, 'tcp');
  try {
    const out = await request(relay, 'CONNECT allowed.test:443 HTTP/1.1');
    expect(out).toContain('200 Connection established');
    expect(out).toContain('hello');
    const s = relay.summary();
    expect(s.broker).toBe('available');
    expect(s.connections).toEqual([{ target: 'allowed.test:443', allowed: 1, refused: 0 }]);
  } finally {
    await relay.close();
    await broker.close();
    await up.close();
  }
});

test('a refused host passes the broker 403 through and is recorded with its reason', async () => {
  const up = await helloServer();
  const broker = await fakeBroker('allowed.test', up.port);
  const relay = await BrokerRelay.start(broker.socket, 'tcp');
  try {
    const out = await request(relay, 'CONNECT evil.test:443 HTTP/1.1');
    expect(out).toContain('403');
    expect(out).toContain('not in the local-commands allowlist');
    const s = relay.summary();
    expect(s.connections).toEqual([
      expect.objectContaining({ target: 'evil.test:443', allowed: 0, refused: 1 }),
    ]);
    expect(s.connections[0]!.reason).toContain('not in the local-commands allowlist');
  } finally {
    await relay.close();
    await broker.close();
    await up.close();
  }
});

test('with the broker socket missing the command gets a 502 and the summary says unavailable', async () => {
  const relay = await BrokerRelay.start('/nonexistent/salaam/local-commands.sock', 'tcp');
  try {
    const out = await request(relay, 'CONNECT allowed.test:443 HTTP/1.1');
    expect(out).toContain('502');
    expect(relay.summary().broker).toBe('unavailable');
  } finally {
    await relay.close();
  }
});

test('the connection summary is bounded', async () => {
  const up = await helloServer();
  const broker = await fakeBroker('allowed.test', up.port);
  const relay = await BrokerRelay.start(broker.socket, 'tcp');
  try {
    for (let i = 0; i < 40; i++) await request(relay, `CONNECT h${i}.test:443 HTTP/1.1`);
    const s = relay.summary();
    expect(s.connections.length).toBeLessThanOrEqual(32);
    expect(s.truncated).toBe(true);
  } finally {
    await relay.close();
    await broker.close();
    await up.close();
  }
});

test('a unix relay socket lives in a private directory removed on close', async () => {
  const up = await helloServer();
  const broker = await fakeBroker('allowed.test', up.port);
  const relay = await BrokerRelay.start(broker.socket, 'unix');
  const dir = relay.dir!;
  expect(existsSync(relay.path!)).toBe(true);
  await relay.close();
  expect(existsSync(dir)).toBe(false);
  await broker.close();
  await up.close();
});

test('bubblewrap keeps the network unshared and binds only the relay into the sandbox', () => {
  const argv = sandboxArgv(
    'workspace-write',
    '/work',
    ['/bin/sh', '-c', 'true'],
    { path: '/usr/bin/bwrap', version: 'x' },
    {
      network: false,
      broker: { dir: '/tmp/salaam-net-x', node: '/usr/local/bin/node' },
    },
  );
  expect(argv).toContain('--unshare-net');
  const joined = argv.join(' ');
  expect(joined).toContain('--bind /tmp/salaam-net-x /run/salaam-net');
  expect(joined).toContain('--ro-bind /usr/local/bin/node /run/salaam-node');
  // The in-sandbox relay runs first and starts the command itself.
  const sep = argv.indexOf('--', argv.indexOf('--chdir'));
  expect(argv.slice(sep + 1, sep + 3)).toEqual(['/run/salaam-node', '-e']);
  expect(argv[sep + 3]).toBe(inSandboxRelaySource);
  expect(argv.slice(sep + 4, sep + 6)).toEqual([
    '/run/salaam-net/relay.sock',
    String(COMMAND_NETWORK_PORT),
  ]);
  expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'true']);
});

test('Seatbelt allows outbound only to the relay port, and no network without it', () => {
  const with_ = seatbeltProfile('workspace-write', '/work', '/tmp/t', {
    network: false,
    brokerPort: 41234,
  });
  expect(with_).toContain('(allow network-outbound (remote tcp "localhost:41234"))');
  expect(with_).not.toContain('(allow network*)');
  const without = seatbeltProfile('workspace-write', '/work', '/tmp/t', { network: false });
  expect(without).not.toContain('network');
});

test('the service hands the manifest broker socket to local commands', async () => {
  const { fixture } = await import('../helpers.js');
  const f = await fixture({ commandNetwork: { socket: '/run/stk/local-commands.sock' } });
  try {
    const local = (f.service as unknown as { localCoding: { sandbox: { network?: unknown } } })
      .localCoding;
    expect(local.sandbox.network).toEqual({ socket: '/run/stk/local-commands.sock' });
  } finally {
    await f.close();
  }
});
