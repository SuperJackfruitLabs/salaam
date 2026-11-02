import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { SalaamService } from '../../src/service/service.js';
import { until } from '../helpers.js';
import type { Session } from '../../src/core/protocol.js';

test('detached CLI forwards the selected Claude route and keeps the key out of logs and API responses', async () => {
  const dir = mkdtempSync('/tmp/sal-claude-cli-'),
    socket = join(dir, 'operator.sock'),
    cli = join(ROOT, 'dist/src/cli/cli.js');
  const run = async (...args: string[]) =>
    (
      await promisify(execFile)(process.execPath, [cli, ...args, '--state', dir], {
        timeout: 15000,
        env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-cli-only-key' },
      })
    ).stdout;
  const route = {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    workspace_id: 'workspace_cli',
  };
  let replacement: SalaamService | undefined;
  try {
    await run(
      'service',
      'start',
      '--provider',
      'anthropic',
      '--model',
      route.model,
      '--max-output-tokens',
      '256',
      '--workspace-id',
      route.workspace_id,
    );
    const health = await call<{ provider_route: unknown }>(socket, '/v1/health');
    expect(health.provider_route).toEqual(route);
    await expect(run('service', 'start', '--provider', 'offline')).rejects.toThrow(
      'another provider route',
    );
    const session = JSON.parse(await run('session', 'create', '--cwd', dir)) as Session;
    await until(
      () => call<Session>(socket, `/v1/sessions/${session.id}`),
      (state) => state.state === 'ready',
    );
    const snapshot = await run('session', 'inspect', session.id);
    expect(snapshot).not.toContain('fixture-cli-only-key');
    expect(readFileSync(join(dir, 'service.log'), 'utf8')).not.toContain('fixture-cli-only-key');
    // No prompt is sent: this integration check makes no provider request.
    await run('service', 'stop');
    await until(async () => {
      try {
        replacement = await SalaamService.open({
          stateDir: dir,
          providerRoute: route,
          anthropicApiKey: 'fixture-cli-only-key',
        });
        return true;
      } catch {
        return false;
      }
    }, Boolean);
    expect(replacement!.store.providerRoute(session.id)).toEqual(route);
    await replacement!.close();
    replacement = undefined;
    replacement = await SalaamService.open({ stateDir: dir });
    const controller = await call<{ token: string; epoch: number }>(
      replacement.socket,
      `/v1/sessions/${session.id}/control`,
      {
        request_id: 'takeover',
        client_id: 'test',
        action: 'acquire',
        expected_epoch: replacement.store.controlView(session.id).epoch,
      },
    );
    await expect(
      call(replacement.socket, `/v1/sessions/${session.id}/resume`, {
        client_id: 'test',
        token: controller.token,
      }),
    ).rejects.toThrow('original provider route');
  } finally {
    if (!replacement)
      try {
        await run('service', 'stop');
      } catch {}
    await replacement?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
