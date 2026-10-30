import { createServer, connect, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A stand-in for stk's local-commands socket: a unix-socket CONNECT proxy that allows exactly one
 * hostname and tunnels it to a local upstream, and refuses everything else with stk's 403 shape. */
export async function fakeBroker(allowed: string, upstreamPort: number) {
  const dir = mkdtempSync(join(tmpdir(), 'salaam-fb-'));
  const socket = join(dir, 'local-commands.sock');
  const seen: string[] = [];
  const server: Server = createServer((client: Socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const line = head.subarray(0, head.indexOf('\r\n')).toString();
      seen.push(line);
      const m = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]$/.exec(line);
      if (!m || m[1] !== allowed) {
        const body = `stk: ${m ? m[1] : 'request'} is not in the local-commands allowlist; the host operator adds it to this server's egress.hosts in the stk policy\n`;
        client.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
        return;
      }
      const up = connect(upstreamPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) up.write(rest);
        client.pipe(up).pipe(client);
      });
      up.on('error', () => client.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(socket, r));
  return {
    socket,
    seen,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A plain HTTP upstream on loopback that answers every request with `hello`. */
export async function helloServer() {
  const server = createServer((s) => {
    s.once('data', () =>
      s.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello'),
    );
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
