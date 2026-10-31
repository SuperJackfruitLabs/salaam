import { expect, test } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { fixture, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { providerRoute } from '../../src/provider-config.js';

test('an interactive session switches model and thinking between turns on the same transcript', async () => {
  const f = await fixture({ anthropicApiKey: 'sk-ant-test-' + 'x'.repeat(40) });
  const root = realpathSync(mkdtempSync('/tmp/sal-route-'));
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(root, false, undefined, true);
    await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    const transcript = f.service.store.session(id).pi_session_id;
    const to = providerRoute('anthropic', undefined, undefined, undefined, undefined, 'high');
    await client.switchRoute(to);
    const ready = await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready' && s.provider_route?.provider === 'anthropic',
    );
    expect(ready.provider_route).toMatchObject({ model: to.model, reasoning: 'high' });
    expect(f.service.store.session(id).pi_session_id).toBe(transcript);
    const changed = f.service.store
      .events(id, 0)
      .filter((e) => e.kind === 'provider.route_changed');
    expect(changed.map((e) => (e.payload as { from: { provider: string } }).from.provider)).toEqual(
      ['salaam-proof'],
    );
  } finally {
    await client.leave().catch(() => {});
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict sessions cannot switch route', async () => {
  const f = await fixture({ anthropicApiKey: 'sk-ant-test-' + 'x'.repeat(40) });
  const root = realpathSync(mkdtempSync('/tmp/sal-route-'));
  try {
    const session = f.service.store.create(root, 'strict');
    expect(() => f.service.store.switchRoute(session.id, providerRoute('anthropic'))).toThrow(
      'Only interactive sessions',
    );
    expect(f.service.tasks.instructions!.applies(session.id)).toBe(false);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
