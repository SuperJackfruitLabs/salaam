import { SalaamService } from '../../dist/src/service.js';
import { providerRoute } from '../../dist/src/provider-config.js';
import { ROOT } from '../../dist/src/config.js';
import { join } from 'node:path';
const service = await SalaamService.open({
  stateDir: process.argv[2],
  providerRoute: providerRoute('anthropic', undefined, 512, 'workspace_fixture'),
  anthropicApiKey: 'fixture-anthropic-key',
  extensionPath: join(ROOT, 'test/fixtures/claude-extension.mjs'),
});
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
