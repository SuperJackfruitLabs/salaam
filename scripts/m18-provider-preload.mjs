import { pathToFileURL } from 'node:url';
import { providerFetch } from './m18-provider-fetch.mjs';
// Pi 1.3.0 captures its initial global fetch in this pinned bundle chunk. Load
// that module first so configureHttpDispatcher preserves the deliberate relay.
// No CLI main or model turn runs while importing this dependency chunk.
if (!process.argv[1]?.endsWith('/dist/bundle/cli.js')) throw Error('Unexpected Pi entrypoint');
await import(new URL('./chunks/chunk-66G7ITPS.js', pathToFileURL(process.argv[1])));
globalThis.fetch = providerFetch(process.env.SALAAM_ACCEPTANCE_PROVIDER_SOCKET);
