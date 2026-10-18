import { SalaamService } from '../../dist/src/service.js';
import { ROOT } from '../../dist/src/config.js';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2],
  route = JSON.parse(readFileSync(join(dir, 'provider-route.json'), 'utf8'));
const credentials = new InMemoryCredentialStore();
await credentials.modify(route.provider, async () => ({
  type: 'api_key',
  key: 'sk-fixture-provider-key',
}));
const service = await SalaamService.open({
  stateDir: dir,
  providerRoute: route,
  providerCredentials: credentials,
  extensionPath: join(ROOT, 'test/fixtures/provider-extension.mjs'),
});
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
