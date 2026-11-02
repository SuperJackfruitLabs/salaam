import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Network for local commands through the broker allowlist (operator rulings 2026-10-30). A command
 * has no network of its own; its only route out is stk's `local-commands` socket, where every
 * connection is the `local-commands` identity and only `servers.local-commands.egress.hosts`
 * decides. Salaam puts a relay of its own in between, outside the sandbox, so what a command
 * reached is counted where the command cannot touch it.
 *
 * Linux: the relay listens on a unix socket in a private directory bound into the bubblewrap
 * sandbox; inside, `inSandboxRelaySource` bridges 127.0.0.1:COMMAND_NETWORK_PORT to it and then
 * starts the command. macOS: the relay listens on 127.0.0.1:<ephemeral>, the only address the
 * Seatbelt profile lets the command connect to.
 */
export const COMMAND_NETWORK_PORT = 3128;
export const DEFAULT_COMMAND_NETWORK_SOCKET = '/run/stk/local-commands.sock';
const MAX_TARGETS = 32;
const MAX_REASON = 300;

export interface CommandNetworkSummary {
  broker: 'available' | 'unavailable';
  connections: { target: string; allowed: number; refused: number; reason?: string }[];
  truncated?: boolean;
}

export class BrokerRelay {
  private counts = new Map<string, { allowed: number; refused: number; reason?: string }>();
  private truncated = false;
  private unavailable = false;
  private sockets = new Set<Socket>();
  private constructor(
    private readonly server: Server,
    private readonly broker: string,
    readonly port: number | null,
    readonly path: string | null,
    readonly dir: string | null,
  ) {}

  /** `tcp`: 127.0.0.1:<ephemeral> (macOS). `unix`: a socket in a new private directory (Linux),
   * readable by the command's user so a tools-user command can reach it. */
  static async start(broker: string, mode: 'tcp' | 'unix'): Promise<BrokerRelay> {
    let relay!: BrokerRelay;
    const server = createServer((client) => relay.handle(client));
    if (mode === 'tcp') {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      relay = new BrokerRelay(
        server,
        broker,
        (server.address() as { port: number }).port,
        null,
        null,
      );
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'salaam-net-'));
      chmodSync(dir, 0o755);
      const path = join(dir, 'relay.sock');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => resolve());
      });
      chmodSync(path, 0o666);
      relay = new BrokerRelay(server, broker, null, path, dir);
    }
    return relay;
  }

  /** A client connection to this relay, for tests. */
  connect(): Socket {
    return this.path ? connect(this.path) : connect(this.port!, '127.0.0.1');
  }

  private record(target: string, allowed: boolean, reason?: string) {
    let entry = this.counts.get(target);
    if (!entry) {
      if (this.counts.size >= MAX_TARGETS) {
        this.truncated = true;
        return;
      }
      entry = { allowed: 0, refused: 0 };
      this.counts.set(target, entry);
    }
    if (allowed) entry.allowed++;
    else {
      entry.refused++;
      if (reason && !entry.reason) entry.reason = reason.slice(0, MAX_REASON);
    }
  }

  private handle(client: Socket) {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n');
      if (end < 0) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off('data', onHead);
      client.pause();
      const line = head.subarray(0, end).toString('latin1');
      const connectLine = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(line);
      const absolute = /^[A-Z]+ http:\/\/([^/\s]+)/.exec(line);
      const target = connectLine
        ? connectLine[1]!.toLowerCase()
        : absolute
          ? (absolute[1]!.includes(':') ? absolute[1]! : absolute[1] + ':80').toLowerCase()
          : 'invalid-request';
      const up = connect(this.broker);
      this.sockets.add(up);
      up.on('close', () => this.sockets.delete(up));
      up.once('error', () => {
        this.unavailable = true;
        this.record(target, false, 'the broker socket is unavailable');
        const body = 'salaam: the command network broker is unavailable\n';
        client.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
      up.once('connect', () => {
        let reply = Buffer.alloc(0),
          decided = false;
        const onReply = (chunk: Buffer) => {
          client.write(chunk);
          if (decided) return;
          reply = Buffer.concat([reply, chunk]);
          const status = /^HTTP\/1\.[01] (\d{3})/.exec(reply.toString('latin1'));
          if (!status) {
            if (reply.length > 8192) decided = true;
            return;
          }
          const code = Number(status[1]);
          if (code >= 200 && code < 300) {
            decided = true;
            this.record(target, true);
            return;
          }
          // A refusal: wait for the body so the reason names the fix, as stk writes it.
          const text = reply.toString('utf8');
          const bodyAt = text.indexOf('\r\n\r\n');
          if (bodyAt >= 0 && text.length > bodyAt + 4) {
            decided = true;
            this.record(
              target,
              false,
              text
                .slice(bodyAt + 4)
                .trim()
                .split('\n')[0],
            );
          }
        };
        up.on('data', onReply);
        up.on('end', () => {
          if (!decided) {
            decided = true;
            const status = /^HTTP\/1\.[01] (\d{3})[^\r\n]*/.exec(reply.toString('latin1'));
            const code = status ? Number(status[1]) : 0;
            this.record(target, code >= 200 && code < 300, status ? status[0] : 'no reply');
          }
          client.end();
        });
        up.write(head);
        client.on('data', (d) => up.write(d));
        client.on('end', () => up.end());
        client.resume();
      });
    };
    client.on('data', onHead);
  }

  summary(): CommandNetworkSummary {
    return {
      broker: this.unavailable ? 'unavailable' : 'available',
      connections: [...this.counts].map(([target, c]) => ({ target, ...c })),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Runs inside the bubblewrap sandbox as `node -e <this> <unix socket> <port> <command...>`: listens
 * on 127.0.0.1:<port> in the sandbox's own network namespace, pipes each connection to the bound
 * relay socket, then starts the command with its stdio and exits with its status. It decides
 * nothing; the host-side relay and stk do.
 */
export const inSandboxRelaySource = `
const net = require('node:net'), { spawn } = require('node:child_process');
const [sock, port, cmd, ...args] = process.argv.slice(1);
const server = net.createServer((c) => {
  const u = net.connect(sock);
  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
  c.pipe(u).pipe(c);
});
server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  child.on('error', () => process.exit(127));
});
server.on('error', () => process.exit(126));
`.trim();
