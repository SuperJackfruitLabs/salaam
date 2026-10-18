import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import house from '../../dist/src/house-extension.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeHttpHandler, NodeHttp2Handler } from '@smithy/node-http-handler';
// Only this fixture redirects validated HTTPS model requests to a disposable server.
export default function fixture(pi) {
  // Cloud credential libraries use Node HTTP instead of global fetch. The fixture
  // permits only its local token server and private service sockets.
  for (const protocol of [http, https]) {
    const request = protocol.request;
    protocol.request = function (...args) {
      const input = args[0];
      const options = typeof input === 'string' ? new URL(input) : input;
      if (
        !options?.socketPath &&
        !['127.0.0.1', 'localhost', '::1'].includes(options?.hostname ?? options?.host)
      )
        throw new Error('Non-local fixture authentication request denied');
      return Reflect.apply(request, this, args);
    };
  }
  syncBuiltinESMExports();

  const raw = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const port = readFileSync(join(process.cwd(), 'provider-port'), 'utf8');
    const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
    return raw(input instanceof Request ? new Request(target, input) : target, init);
  };
  const rawHandle = NodeHttpHandler.prototype.handle;
  const handler = new NodeHttpHandler();
  for (const prototype of [NodeHttpHandler.prototype, NodeHttp2Handler.prototype])
    prototype.handle = function (request, options) {
      return Reflect.apply(rawHandle, handler, [
        {
          ...request,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(([key]) => !key.startsWith(':')),
          ),
          protocol: 'http:',
          hostname: '127.0.0.1',
          port: Number(readFileSync(join(process.cwd(), 'provider-port'), 'utf8')),
        },
        options,
      ]);
    };
  house(pi);
  pi.on('before_provider_headers', (event) => {
    event.headers['x-salaam-test'] = 'callback';
  });
  pi.on('before_provider_request', (event) => {
    writeFileSync(join(process.cwd(), 'provider-payload'), JSON.stringify(event.payload));
    if (readFileSync(join(process.cwd(), 'provider-mode'), 'utf8') === 'payload-fault')
      return { model: 'forbidden' };
  });
}
