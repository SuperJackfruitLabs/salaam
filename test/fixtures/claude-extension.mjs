import house from '../../dist/src/runtime/house-extension.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function fixture(pi) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://api.anthropic.com') throw new Error('Unexpected provider endpoint');
    const port = readFileSync(join(process.cwd(), 'claude-port'), 'utf8');
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  house(pi);
  pi.on('before_provider_headers', (event) => {
    event.headers['x-salaam-test'] = 'callback';
  });
  pi.on('after_provider_response', () => {
    writeFileSync(join(process.cwd(), 'callback-response'), 'seen');
  });
  pi.on('provider_stream_event', () => {
    writeFileSync(join(process.cwd(), 'callback-stream'), 'seen');
  });
  pi.on('before_provider_request', (event) => {
    writeFileSync(join(process.cwd(), 'captured-payload'), JSON.stringify(event.payload));
  });
  if (readFileSync(join(process.cwd(), 'claude-mode'), 'utf8') === 'context-fault')
    pi.on('context', () => {
      throw new Error('Injected context failure');
    });
  if (readFileSync(join(process.cwd(), 'claude-mode'), 'utf8') === 'payload-fault')
    pi.on('before_provider_request', () => ({ model: 'forbidden' }));
}
