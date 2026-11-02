import {
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, BlockList } from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { digest, oneOf, ServiceError } from '../core/index.js';
import { repositoryPath } from '../workers/index.js';

export const A2A_PIN = {
  specification: '1.0.0',
  wire: '1.0',
  sdk: '1.0.1',
  transport: 'JSONRPC',
} as const;
export type A2AObject = Record<string, unknown>;
// A2A 1.0 records as Salaam reads them. Every field is still checked where it is used; these
// only name the shapes the protocol defines.
export type A2AMessage = {
  messageId?: unknown;
  role?: unknown;
  parts?: unknown;
  metadata?: A2AObject;
  taskId?: unknown;
  contextId?: unknown;
  referenceTaskIds?: unknown[];
  extensions?: unknown[];
};
export type A2AArtifact = { artifactId: string; parts?: unknown; [field: string]: unknown };
export type A2ATask = {
  id: string;
  contextId: string;
  status: { state: string; message?: A2AMessage };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: A2AObject;
};
export type A2APeer = {
  id: string;
  endpoint: string;
  card_url: string;
  card_digest: string;
  tenant: string;
  skill: string;
  addresses: string[];
  local: boolean;
  credential_file: string;
  credential_digest: string;
  files: string[];
  retention: 'volatile' | 'durable' | 'unknown';
  cancel: boolean;
  streaming: boolean;
};
const fail = (message: string): never => {
  throw new ServiceError('a2a_contract', message);
};
/** A JSON object, read as the A2A record its caller names. This is the parse boundary: the
 * caller checks each field it reads, and T only names the shape it expects. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function a2aObject<T extends A2AObject = A2AObject>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('Expected an A2A object');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T;
}
export function a2aIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return fail('Invalid A2A identity');
  return value;
}
export function privateJSON(path: string): unknown {
  if (realpathSync(path) !== path)
    return fail('Configuration must use its canonical absolute path');
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    s.size > 262144 ||
    s.mode & 0o077 ||
    s.uid !== process.getuid?.()
  )
    return fail('Peer configuration and credentials must be owner-only regular files');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      before.dev !== s.dev ||
      before.ino !== s.ino ||
      before.nlink !== 1 ||
      before.size !== s.size ||
      before.uid !== s.uid ||
      before.mode !== s.mode
    )
      return fail('Peer configuration changed during admission');
    const bytes = readFileSync(fd, 'utf8'),
      after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return fail('Peer configuration changed while reading');
    return JSON.parse(bytes);
  } finally {
    closeSync(fd);
  }
}
export function peerCredential(peer: A2APeer): string {
  const value = a2aObject(privateJSON(peer.credential_file));
  if (
    Object.keys(value).toSorted().join(',') !== 'peer,token' ||
    value.peer !== peer.id ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9._~-]{32,512}$/.test(value.token) ||
    digest(value) !== peer.credential_digest
  )
    return fail('Peer credential identity changed; renew admission');
  return value.token;
}
export function equalToken(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function validatePeer(value: unknown): A2APeer {
  const p = a2aObject(value);
  const keys = [
    'id',
    'endpoint',
    'card_url',
    'card_digest',
    'tenant',
    'skill',
    'addresses',
    'local',
    'credential_file',
    'credential_digest',
    'files',
    'retention',
    'cancel',
    'streaming',
  ];
  if (Object.keys(p).toSorted().join(',') !== keys.sort().join(','))
    return fail('Unknown or missing peer configuration field');
  for (const key of ['id', 'skill']) a2aIdentity(p[key]);
  if (typeof p.tenant !== 'string' || p.tenant.length > 256 || /[\x00-\x1f\x7f]/.test(p.tenant))
    return fail('Invalid tenant');
  for (const key of ['card_digest', 'credential_digest'])
    if (!/^[a-f0-9]{64}$/.test(String(p[key]))) return fail('Expected reviewed SHA-256 digest');
  if (
    typeof p.local !== 'boolean' ||
    typeof p.cancel !== 'boolean' ||
    typeof p.streaming !== 'boolean' ||
    !oneOf(['volatile', 'durable', 'unknown'], p.retention)
  )
    return fail('Explicit peer capability and retention policy required');
  const endpoint = new URL(String(p.endpoint)),
    card = new URL(String(p.card_url));
  for (const u of [endpoint, card]) {
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.href !== (u === endpoint ? p.endpoint : p.card_url)
    )
      return fail('Canonical peer URLs cannot contain credentials, queries or fragments');
    if (
      u.protocol !== 'https:' &&
      !(p.local && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))
    )
      return fail('HTTPS required except explicitly configured loopback rehearsal');
  }
  if (endpoint.origin !== card.origin) return fail('Agent Card must share the configured origin');
  const denied = new BlockList();
  denied.addSubnet('169.254.0.0', 16);
  denied.addSubnet('0.0.0.0', 8);
  denied.addSubnet('224.0.0.0', 4);
  denied.addSubnet('fe80::', 10, 'ipv6');
  denied.addSubnet('ff00::', 8, 'ipv6');
  denied.addAddress('::', 'ipv6');
  if (
    !Array.isArray(p.addresses) ||
    !p.addresses.length ||
    p.addresses.length > 8 ||
    new Set(p.addresses).size !== p.addresses.length
  )
    return fail('Pin explicit destination IP addresses');
  for (const address of p.addresses) {
    const family = isIP(address);
    if (
      !family ||
      address.includes('%') ||
      denied.check(address, family === 6 ? 'ipv6' : 'ipv4') ||
      (!p.local && (address.startsWith('127.') || address === '::1'))
    )
      return fail('Forbidden peer destination');
    if (family === 6 && address.toLowerCase().includes('ffff:'))
      return fail('Mapped destination addresses are unsupported');
    if (p.local && !['127.0.0.1', '::1'].includes(address))
      return fail('Local rehearsal must remain on loopback');
  }
  if (
    isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) &&
    !p.addresses.includes(endpoint.hostname.replace(/^\[|\]$/g, ''))
  )
    return fail('URL literal must match the pinned address');
  if (!Array.isArray(p.files) || p.files.length > 64 || new Set(p.files).size !== p.files.length)
    return fail('Bound explicit disclosure paths');
  for (const path of p.files) repositoryPath(path);
  const peer = p as A2APeer;
  peerCredential(peer);
  return structuredClone(peer);
}
/** No redirects, DNS fallback, cookies, inherited proxy or provider credentials. */
export class A2AHttp {
  constructor(readonly peer: A2APeer) {}
  async request<T extends A2AObject = A2AObject>(url: string, body?: unknown): Promise<T> {
    const p = validatePeer(this.peer),
      u = new URL(url);
    if (url !== p.endpoint && url !== p.card_url) return fail('Unconfigured A2A destination');
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > 262144) return fail('A2A disclosure exceeds request bound');
    const token = peerCredential(p);
    return new Promise((resolve, reject) => {
      const request = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method: bytes ? 'POST' : 'GET',
          agent: false,
          headers: {
            Authorization: `Bearer ${token}`,
            'A2A-Version': A2A_PIN.wire,
            Accept: 'application/json',
            ...(bytes
              ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) }
              : {}),
          },
          lookup: (_hostname, options, callback) => {
            const address = p.addresses[0]!;
            if (typeof options === 'object' && options.all)
              callback(null, [{ address, family: isIP(address) }]);
            else callback(null, address, isIP(address));
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^application\/json(?:;|$)/i.test(String(response.headers['content-type']))
          ) {
            response.destroy();
            reject(Error('Peer returned an unsupported status or media type'));
            return;
          }
          if (response.headers['a2a-version'] && response.headers['a2a-version'] !== A2A_PIN.wire) {
            response.destroy();
            reject(Error('Peer wire version changed'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1048576) response.destroy(Error('Peer response exceeds bound'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve(a2aObject<T>(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      const timeout = body && a2aObject(body).method === 'SendMessage' ? 60000 : 10000;
      const deadline = setTimeout(
        () =>
          request.destroy(
            Error('A2A absolute request deadline exceeded; acceptance may be unknown'),
          ),
        timeout,
      );
      request.once('close', () => clearTimeout(deadline));
      request.setTimeout(timeout, () =>
        request.destroy(Error('A2A request timed out; acceptance may be unknown')),
      );
      request.on('error', reject);
      request.end(bytes);
    });
  }
  async card(): Promise<A2AObject> {
    return this.assertCard(await this.request(this.peer.card_url));
  }
  assertCard(card: A2AObject): A2AObject {
    if (digest(card) !== this.peer.card_digest)
      return fail('Agent Card changed; operator review required');
    if (
      !Array.isArray(card.supportedInterfaces) ||
      !card.supportedInterfaces.length ||
      card.supportedInterfaces.some(
        (i: {
          url?: unknown;
          protocolBinding?: unknown;
          protocolVersion?: unknown;
          tenant?: unknown;
        }) =>
          i.url !== this.peer.endpoint ||
          i.protocolBinding !== 'JSONRPC' ||
          i.protocolVersion !== '1.0' ||
          (i.tenant ?? '') !== this.peer.tenant,
      )
    )
      return fail('Agent Card interface differs from configured peer/version/tenant');
    if (
      !Array.isArray(card.skills) ||
      !card.skills.some((s: { id?: unknown }) => s.id === this.peer.skill)
    )
      return fail('Configured peer skill is absent');
    const caps = a2aObject(card.capabilities);
    if (this.peer.streaming && caps.streaming !== true) return fail('Streaming capability changed');
    return card;
  }
  async subscribe(task: string, consume: (event: A2AObject) => void): Promise<void> {
    const p = validatePeer(this.peer),
      u = new URL(p.endpoint),
      id = randomUUID();
    const bytes = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'SubscribeToTask',
        params: { id: task, tenant: p.tenant },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const request = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
        u,
        {
          method: 'POST',
          agent: false,
          headers: {
            Authorization: `Bearer ${peerCredential(p)}`,
            'A2A-Version': '1.0',
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'Content-Length': String(bytes.length),
          },
          lookup: (_hostname, options, callback) => {
            const address = p.addresses[0]!;
            if (typeof options === 'object' && options.all)
              callback(null, [{ address, family: isIP(address) }]);
            else callback(null, address, isIP(address));
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^text\/event-stream(?:;|$)/i.test(String(response.headers['content-type'])) ||
            (response.headers['a2a-version'] && response.headers['a2a-version'] !== '1.0')
          ) {
            response.destroy();
            reject(Error('Peer streaming unavailable'));
            return;
          }
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let buffer = '',
            size = 0,
            events = 0,
            terminalSeen = false,
            done = false;
          response.on('error', reject);
          response.on('data', (chunk: Buffer) => {
            try {
              size += chunk.length;
              if (size > 1048576) throw Error('Peer stream exceeds bound');
              buffer += decoder.decode(chunk, { stream: true });
              if (buffer.length > 524288) throw Error('Peer SSE frame exceeds bound');
              for (;;) {
                const match = /\r?\n\r?\n/.exec(buffer);
                if (!match) break;
                const frame = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                const data = frame
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                if (!data) continue;
                if (done)
                  throw new ServiceError('a2a_identity', 'Stream continued after its terminator');
                if (data === '[DONE]') {
                  if (!terminalSeen)
                    throw new ServiceError('a2a_identity', 'Premature stream terminator');
                  done = true;
                  continue;
                }
                if (++events > 128) throw Error('Peer stream event bound exceeded');
                const event = a2aObject(JSON.parse(data));
                if (event.jsonrpc !== '2.0' || event.id !== id)
                  throw new ServiceError('a2a_identity', 'Unowned stream response');
                if (event.error) throw Error('Peer stream operation failed');
                const result = a2aObject<{
                  statusUpdate?: { status?: { state?: unknown } };
                  task?: { status?: { state?: unknown } };
                }>(event.result);
                consume(result);
                if (
                  oneOf(
                    [
                      'TASK_STATE_COMPLETED',
                      'TASK_STATE_FAILED',
                      'TASK_STATE_CANCELED',
                      'TASK_STATE_REJECTED',
                    ],
                    result.statusUpdate?.status?.state ?? result.task?.status?.state,
                  )
                )
                  terminalSeen = true;
              }
            } catch (e) {
              response.destroy();
              request.destroy();
              reject(e);
            }
          });
          response.on('end', () => {
            try {
              decoder.decode();
              if (buffer.trim()) throw Error('Peer stream ended mid-frame');
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      const deadline = setTimeout(
        () => request.destroy(Error('A2A stream deadline; reconcile existing task')),
        15000,
      );
      request.once('close', () => clearTimeout(deadline));
      request.on('error', reject);
      request.end(bytes);
    });
  }
  async rpc(
    method: 'SendMessage' | 'GetTask' | 'CancelTask',
    params: A2AObject,
  ): Promise<A2AObject> {
    const id = randomUUID(),
      response = await this.request<A2AObject & { error?: { code?: unknown } }>(
        this.peer.endpoint,
        {
          jsonrpc: '2.0',
          id,
          method,
          params: { ...params, tenant: this.peer.tenant },
        },
      );
    if (
      response.jsonrpc !== '2.0' ||
      response.id !== id ||
      Object.hasOwn(response, 'error') === Object.hasOwn(response, 'result')
    )
      return fail('Unowned or malformed A2A response');
    if (response.error)
      throw new ServiceError('a2a_remote_error', `Peer error ${Number(response.error.code)}`);
    return a2aObject(response.result);
  }
}
