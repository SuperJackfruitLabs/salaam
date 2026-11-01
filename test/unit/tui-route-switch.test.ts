import { test, expect, vi } from 'vitest';
import { SalaamApp } from '../../src/tui.js';
import { ServiceError, type SessionSnapshot } from '../../src/protocol.js';
import { providerRoute } from '../../src/provider-config.js';

type Internal = {
  applyRoute(route: ReturnType<typeof providerRoute>): Promise<void>;
  newSession(): Promise<void>;
  selectedRoute?: ReturnType<typeof providerRoute>;
};
function app(switchRoute: () => Promise<void>) {
  const a = new SalaamApp({ state: '/tmp/salaam-route-switch-proof' });
  a.client.snapshot = {
    id: 's1',
    provider_route: { provider: 'openai-codex', model: 'gpt-5' },
  } as unknown as SessionSnapshot;
  Object.defineProperty(a.client, 'controlling', { get: () => true });
  a.client.switchRoute = vi.fn(switchRoute);
  const internal = a as unknown as Internal;
  internal.newSession = vi.fn(async () => {});
  return { a, internal };
}

test('a model that cannot join the session opens a new session with that model, not the old one', async () => {
  const { a, internal } = app(async () => {
    throw new ServiceError(
      'provider_output_cap_changed',
      'That route enforces output caps differently; start a new session for it',
      409,
    );
  });
  const chosen = providerRoute('anthropic');
  await internal.applyRoute(chosen);
  expect(internal.selectedRoute).toEqual(chosen);
  expect(internal.newSession).toHaveBeenCalledTimes(1);
  expect(a.client.notice).toContain('starts in a new session');
});

test('a switch that works stays in this session, and other refusals are reported as they are', async () => {
  const ok = app(async () => {});
  await ok.internal.applyRoute(providerRoute('anthropic'));
  expect(ok.internal.newSession).not.toHaveBeenCalled();
  expect(ok.internal.selectedRoute).toBeUndefined();
  const busy = app(async () => {
    throw new ServiceError('worker_busy', 'A turn is running', 409);
  });
  await expect(busy.internal.applyRoute(providerRoute('anthropic'))).rejects.toThrow(
    'A turn is running',
  );
  expect(busy.internal.newSession).not.toHaveBeenCalled();
});
