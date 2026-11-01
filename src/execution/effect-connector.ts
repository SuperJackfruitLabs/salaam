import { request } from 'node:http';
import { canonical, object, string } from '../core/index.js';

export interface EffectInput {
  target: string;
  value: string;
  target_version: string;
  argument_digest: string;
}
export interface EffectReceipt {
  id: string;
  accepted: true;
  payload: EffectInput;
}
export interface EffectConnector {
  readonly id: string;
  readonly replay: 'lookup' | 'opaque';
  version(target: string, signal: AbortSignal): Promise<string>;
  dispatch(key: string, input: EffectInput, signal: AbortSignal): Promise<EffectReceipt>;
  lookup?(key: string, signal: AbortSignal): Promise<EffectReceipt | null>;
}
export class DefiniteFailure extends Error {}

/** Explicit local fixture protocol; no discovery, credentials or live services. */
export class SocketEffectConnector implements EffectConnector {
  readonly id: string;
  readonly replay: 'lookup' | 'opaque';
  constructor(
    readonly socket: string,
    readonly options: { opaque?: boolean; timeoutMs?: number } = {},
  ) {
    this.replay = options.opaque ? 'opaque' : 'lookup';
    this.id = `socket-effect-v1:${socket}:${this.replay}`;
  }
  private call(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          path,
          agent: false,
          signal,
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', ...headers },
        },
        (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 256 * 1024) res.destroy(new Error('Effect response too large'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 500,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(this.options.timeoutMs ?? 2000, () =>
        req.destroy(new Error('Effect transport timed out')),
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async version(target: string, signal: AbortSignal): Promise<string> {
    const response = await this.call('/targets/' + encodeURIComponent(target), signal);
    if (response.status !== 200) throw new Error('Target version unavailable');
    return string(object(response.body).version, 'target version', 128);
  }
  async dispatch(key: string, input: EffectInput, signal: AbortSignal): Promise<EffectReceipt> {
    const response = await this.call('/effects', signal, input, {
      'if-match': input.target_version,
      ...(this.replay === 'lookup' ? { 'idempotency-key': key } : {}),
    });
    if (response.status === 412) throw new DefiniteFailure('External target version changed');
    if (response.status !== 200)
      throw new Error('Effect acceptance is uncertain: HTTP ' + response.status);
    const receipt = this.receipt(response.body);
    if (
      canonical(receipt.payload) !== canonical(input) ||
      (this.replay === 'lookup' && receipt.id !== key)
    )
      throw new Error('Effect receipt binding mismatch');
    return receipt;
  }
  async lookup(key: string, signal: AbortSignal): Promise<EffectReceipt | null> {
    if (this.replay !== 'lookup') throw new Error('Connector has no status lookup');
    const response = await this.call('/effects/' + encodeURIComponent(key), signal);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error('Effect status unavailable');
    return this.receipt(response.body);
  }
  private receipt(body: unknown): EffectReceipt {
    const value = object(body);
    const payload = object(value.payload);
    if (value.accepted !== true) throw new Error('Effect receipt is not positive acceptance');
    return {
      id: string(value.id, 'receipt ID', 128),
      accepted: true,
      payload: {
        target: string(payload.target, 'target', 256),
        value: string(payload.value, 'value', 4096),
        target_version: string(payload.target_version, 'target version', 128),
        argument_digest: string(payload.argument_digest, 'argument digest', 128),
      },
    };
  }
}
