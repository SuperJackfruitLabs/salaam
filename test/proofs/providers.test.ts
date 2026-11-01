import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { getProvider, providerRoute, PI_PROVIDERS } from '../../src/provider-config.js';
import { SalaamService } from '../../src/service.js';
import { PiProcess } from '../../src/pi.js';
import { ROOT } from '../../src/config.js';
import { create, ready, until, control } from '../helpers.js';
import { submit } from '../managed-helpers.js';
import { client } from '../acp-helpers.js';
import { randomUUID } from 'node:crypto';

const routes = PI_PROVIDERS.filter((p) => p.id !== 'openai-codex').flatMap((p) =>
  [...new Set(p.getModels().map((m) => m.api))].map((api) => [p.id, api] as const),
);

test.each(['max-output', 'refusal'])(
  'M19.4: real provider %s after partial text is a durable failure',
  async (mode) => {
    const f = await setup('anthropic', 'anthropic-messages', mode);
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      const request = await submit(f.service, session.id, 'Return a fixture partial response');
      const final = await until(
        () => f.service.store.attempt(request.attempt_id),
        (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
      );
      expect(final).toMatchObject({
        state: 'failed',
        outcome: {
          version: 1,
          stopReason: mode === 'max-output' ? 'max_tokens' : 'refusal',
          failure: { kind: mode === 'max-output' ? 'max_tokens' : 'refusal' },
        },
      });
      expect((await f.stats()).count).toBe(1);
      const a = client(f.dir);
      try {
        await a.initialize({
          _meta: {
            'salaam.dev/executionFeatures': {
              failures: 1,
              cancellationReceipts: 1,
              toolSemantics: 1,
            },
          },
        });
        await a.request('session/load', { sessionId: session.id, cwd: f.dir, mcpServers: [] });
        const logical = randomUUID();
        const result = await a.request('session/prompt', {
          sessionId: session.id,
          prompt: [{ type: 'text', text: 'Partial output through ACP' }],
          _meta: { 'salaam.dev/requestId': logical, 'salaam.dev/takeover': true },
        });
        expect(result).toMatchObject({
          stopReason: mode === 'max-output' ? 'max_tokens' : 'refusal',
          _meta: {
            'salaam.dev/failure': {
              sessionId: session.id,
              requestId: logical,
              kind: mode === 'max-output' ? 'max_tokens' : 'refusal',
            },
          },
        });
        expect(result._meta['salaam.dev/failure'].attemptId).toBe(
          result._meta['salaam.dev/attemptId'],
        );
        expect((await f.stats()).count).toBe(2);
      } finally {
        await a.close();
      }
      await f.restart();
      expect(f.service.store.attempt(request.attempt_id)).toMatchObject({
        state: 'failed',
        outcome: { stopReason: mode === 'max-output' ? 'max_tokens' : 'refusal' },
      });
    } finally {
      await f.close();
    }
  },
);
async function setup(
  provider: string,
  api: string,
  mode = 'tool',
  oauth = false,
  beforeOpen?: (credentials: InMemoryCredentialStore, dir: string) => Promise<void>,
) {
  const dir = mkdtempSync('/tmp/sal-providers-');
  writeFileSync(join(dir, 'provider-mode'), mode);
  writeFileSync(join(dir, 'provider-api'), api);
  const mock = spawn(process.execPath, [join(ROOT, 'test/fixtures/mock-provider.mjs'), dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors: string[] = [];
  mock.stderr.on('data', (c) => {
    errors.push(String(c));
    console.error(String(c));
  });
  await Promise.race([
    once(mock.stdout, 'data'),
    once(mock, 'exit').then(() => {
      throw new Error(errors.join(''));
    }),
  ]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => ({
    type: 'api_key',
    key: provider === 'openai' ? 'sk-fixture-provider-key' : 'fixture-provider-key',
    env: {
      AZURE_OPENAI_RESOURCE_NAME: 'fixture',
      CLOUDFLARE_ACCOUNT_ID: 'fixture',
      CLOUDFLARE_GATEWAY_ID: 'fixture',
      GOOGLE_CLOUD_PROJECT: 'fixture',
      GOOGLE_CLOUD_LOCATION: 'global',
      AWS_REGION: 'us-east-1',
    },
  }));
  if (oauth)
    await credentials.modify(provider, async () => ({
      type: 'oauth',
      access:
        'fixture-provider-key.' +
        Buffer.from(
          JSON.stringify({
            'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
          }),
        ).toString('base64url') +
        '.fixture',
      refresh: 'fixture-refresh',
      expires: Date.now() + 3600000,
    }));
  try {
    await beforeOpen?.(credentials, dir);
  } catch (error) {
    mock.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const model = getProvider(provider)!
    .getModels()
    .find((m) => m.api === api)!;
  const options = {
    launch: (launch: import('../../src/supervisor.js').Launch) => {
      const pi = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
      return pi;
    },
    stateDir: dir,
    providerRoute: providerRoute(provider, model.id, 512),
    providerCredentials: credentials,
    providerEnvironment: {},
    extensionPath: join(ROOT, 'test/fixtures/provider-extension.mjs'),
  };
  let service: SalaamService;
  try {
    service = await SalaamService.open(options);
  } catch (error) {
    mock.kill('SIGKILL');
    throw error;
  }
  const stats = async () =>
    (await (
      await fetch('http://127.0.0.1:' + readFileSync(join(dir, 'provider-port'), 'utf8') + '/stats')
    ).json()) as {
      count: number;
      auth_count: number;
      bodies: {
        url: string;
        body: Record<string, unknown>;
        authenticated: boolean;
        callback: boolean;
        sigv4: boolean;
      }[];
    };
  return {
    dir,
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = await SalaamService.open(options);
    },
    options,
    credentials,
    stats,
    async close() {
      await service.close();
      if (mock.exitCode === null && mock.signalCode === null) {
        const exit = once(mock, 'exit');
        mock.kill('SIGKILL');
        await exit;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test.each(routes)(
  '%s/%s: real Pi streams, gates a tool and records each request once',
  async (provider, api) => {
    const f = await setup(provider, api);
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      const request = await submit(f.service, session.id, 'Run the managed probe then reply.');
      const final = await until(
        () => f.service.store.attempt(request.attempt_id),
        (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
      );
      const stats = await f.stats();
      expect(
        final,
        JSON.stringify({
          final,
          stats: { count: stats.count },
          session: f.service.store.session(session.id).error,
          payloadModel: existsSync(join(f.dir, 'provider-payload'))
            ? JSON.parse(readFileSync(join(f.dir, 'provider-payload'), 'utf8')).model
            : null,
        }),
      ).toMatchObject({ state: 'completed', result: 'Provider fixture complete.' });
      expect(stats.count).toBe(2);
      expect(stats.bodies.every((b) => b.authenticated && b.callback)).toBe(true);
      expect(
        f.service.store.events(session.id, 0).filter((e) => e.kind === 'tool.granted'),
      ).toHaveLength(1);
      expect(f.service.store.usage.summary(session.id)).toMatchObject({
        observations: 2,
        unknown_observations: 0,
        estimated_observations: 2,
        known_output: 16,
      });
      expect(JSON.stringify(f.service.store.snapshot(session.id))).not.toContain(
        'fixture-provider-key',
      );
      expect(Object.keys(f.service.supervisor.options)).not.toContain('apiKey');
    } finally {
      await f.close();
    }
  },
);

test.each(['openai', 'openai-codex'])(
  '%s OAuth requires explicit token-budget opt-out and preserves durable task admission across restart',
  async (provider) => {
    const api = provider === 'openai' ? 'openai-responses' : 'openai-codex-responses';
    const f = await setup(provider, api, 'tool', true);
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      expect(f.service.supervisor.providerCapabilities()).toMatchObject({
        output_token_cap: false,
        durable_tasks: true,
      });
      const request = await submit(f.service, session.id, 'Probe then reply.');
      const final = await until(
        () => f.service.store.attempt(request.attempt_id),
        (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
      );
      expect(
        final,
        JSON.stringify({
          final,
          session: f.service.store.session(session.id),
          stats: await f.stats(),
          payload: readFileSync(join(f.dir, 'provider-payload'), 'utf8'),
        }),
      ).toMatchObject({ state: 'completed', result: 'Provider fixture complete.' });
      expect((await f.stats()).count).toBe(2);
      const actor = await control(f.service, session.id, true);
      const { call } = await import('../../src/transport.js');
      expect(await call(f.service.socket, '/v1/health')).toMatchObject({
        task_execution: { durable_tasks: true, task_budgets: true, task_token_budgets: false },
      });
      await expect(
        call(f.service.socket, '/v1/tasks', {
          ...actor,
          request_id: 'uncapped-task',
          session_id: session.id,
          expected_revision: 0,
          plan: {
            objective: 'Do work',
            constraints: [],
            steps: [{ key: 'one', title: 'One', instruction: 'Do work', depends_on: [] }],
          },
        }),
      ).rejects.toThrow('no output cap');
      expect(
        f.service.store.db.prepare('SELECT count(*) AS n FROM durable_tasks').get(),
      ).toMatchObject({ n: 0 });
      expect((await f.stats()).count).toBe(2);
      const plan = {
        objective: 'Do durable work',
        constraints: [],
        limits: { token_units: null, requests: 1 },
        steps: [{ key: 'one', title: 'One', instruction: 'Probe then reply.', depends_on: [] }],
      };
      const taskBody = { ...actor, session_id: session.id, expected_revision: 0, plan };
      await expect(
        call(f.service.socket, '/v1/tasks', {
          ...taskBody,
          request_id: 'explicit-unsupported-cap',
          plan: { ...plan, limits: { token_units: null, output_token_bound: 512 } },
        }),
      ).rejects.toThrow('no output cap');
      const task = await call<import('../../src/records.js').WorkTask>(
        f.service.socket,
        '/v1/tasks',
        {
          ...taskBody,
          request_id: 'uncapped-durable-task',
        },
      );
      expect(task.limits).toMatchObject({
        token_units: null,
        output_token_bound: null,
        requests: 1,
      });
      const path = `/v1/tasks/${task.id}/steps/${task.steps[0]!.id}/run`;
      const stepBody = { ...actor, expected_revision: task.revision, request_id: 'uncapped-step' };
      const accepted = await call<{ attempt_id: string }>(f.service.socket, path, stepBody);
      await until(
        () => f.service.store.attempt(accepted.attempt_id),
        (a) => a.state === 'completed',
      );
      expect((await f.stats()).count).toBe(3);
      expect((await f.stats()).bodies.every((b) => b.body.max_output_tokens === undefined)).toBe(
        true,
      );
      await f.restart();
      const restored = f.service.taskWork.get(task.id);
      expect(restored.steps[0]!.attempt_id).toBe(accepted.attempt_id);
      expect(restored.limits.token_units).toBeNull();
      expect(f.service.taskBudget.state(task.id)).toMatchObject({
        requests_spent: 1,
        token_units: 0,
        reserved_tokens: 0,
      });
      expect(await call(f.service.socket, path, stepBody)).toEqual(accepted);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await f.stats()).count).toBe(3);
      expect(() =>
        f.service.store.usage.admit(
          session.id,
          accepted.attempt_id,
          'over-limit',
          provider,
          f.options.providerRoute.model,
          { input: 10, output: 999999 },
        ),
      ).toThrow('request limit');
      expect((await f.stats()).count).toBe(3);
    } finally {
      await f.close();
    }
  },
);

const apiFamilies = routes.filter(
  ([, api], index, all) => all.findIndex(([, other]) => other === api) === index,
);
test.each(apiFamilies)(
  '%s/%s refuses altered payloads before model admission or HTTP',
  async (provider, api) => {
    const f = await setup(provider, api, 'payload-fault');
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      await submit(f.service, session.id, 'Do not dispatch altered payload');
      await until(
        () => f.service.supervisor.inspect(session.id).state,
        (s) => s === 'unhealthy',
      );
      expect((await f.stats()).count).toBe(0);
      expect(f.service.store.usage.summary(session.id)).toMatchObject({ observations: 0 });
    } finally {
      await f.close();
    }
  },
);

test.each(apiFamilies)(
  '%s/%s never retries a 429 or leaks its error body',
  async (provider, api) => {
    const f = await setup(provider, api, '429');
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      const request = await submit(f.service, session.id, 'Request fixture rate limit');
      const final = await until(
        () => f.service.store.attempt(request.attempt_id),
        (a) => ['failed', 'interrupted'].includes(a.state),
      );
      expect((await f.stats()).count).toBe(1);
      expect(f.service.store.usage.summary(session.id)).toMatchObject({
        observations: 1,
        unknown_observations: 1,
      });
      expect(JSON.stringify({ final, snapshot: f.service.store.snapshot(session.id) })).not.toMatch(
        /SECRET|fixture-provider-key/,
      );
      expect(f.service.supervisor.inspect(session.id).state).toBe('ready');
    } finally {
      await f.close();
    }
  },
);

test.each([
  ['google', 'google-generative-ai'],
  ['openai', 'openai-responses'],
  ['amazon-bedrock', 'bedrock-converse-stream'],
])('%s cancellation preserves unknown usage without a replay', async (provider, api) => {
  const f = await setup(provider, api, 'hold');
  try {
    const { call } = await import('../../src/transport.js');
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const request = await submit(f.service, session.id, 'Wait for cancellation');
    await until(() => existsSync(join(f.dir, 'provider-entered')), Boolean);
    const actor = await control(f.service, session.id, true);
    await call(f.service.socket, `/v1/attempts/${request.attempt_id}/cancel`, {
      ...actor,
      request_id: 'cancel-provider',
      expected_revision: f.service.store.session(session.id).revision,
    });
    await until(
      () => f.service.store.attempt(request.attempt_id),
      (a) => a.state === 'cancelled',
    );
    expect((await f.stats()).count).toBe(1);
    expect(f.service.store.usage.summary(session.id)).toMatchObject({ unknown_observations: 1 });
  } finally {
    await f.close();
  }
});

test('OpenAI daemon death retains route, session identity and unknown usage without redispatch', async () => {
  const f = await setup('openai', 'openai-responses', 'hold');
  let daemon: ReturnType<typeof spawn> | undefined, replacement: SalaamService | undefined;
  try {
    const { call } = await import('../../src/transport.js');
    await f.service.close();
    writeFileSync(join(f.dir, 'provider-route.json'), JSON.stringify(f.options.providerRoute));
    daemon = spawn(process.execPath, [join(ROOT, 'test/fixtures/provider-service.mjs'), f.dir]);
    await once(daemon.stdout!, 'data');
    const socket = join(f.dir, 'operator.sock');
    const session = await call<import('../../src/protocol.js').Session>(socket, '/v1/sessions', {
      request_id: 'create',
      cwd: f.dir,
    });
    await until(
      () => call<import('../../src/protocol.js').Session>(socket, `/v1/sessions/${session.id}`),
      (s) => s.state === 'ready',
    );
    const lease = await call<{ token: string }>(socket, `/v1/sessions/${session.id}/control`, {
      request_id: 'lease',
      client_id: 'test',
      action: 'acquire',
      expected_epoch: 0,
    });
    const current = await call<import('../../src/protocol.js').Session>(
      socket,
      `/v1/sessions/${session.id}`,
    );
    const request = await call<{ attempt_id: string }>(
      socket,
      `/v1/sessions/${session.id}/submissions`,
      {
        request_id: 'submit',
        client_id: 'test',
        token: lease.token,
        expected_revision: current.revision,
        text: 'Hold',
      },
    );
    await until(() => existsSync(join(f.dir, 'provider-entered')), Boolean);
    const exited = once(daemon, 'exit');
    daemon.kill('SIGKILL');
    await exited;
    replacement = await SalaamService.open(f.options);
    expect(replacement.store.providerRoute(session.id)).toEqual(replacement.supervisor.route);
    expect(replacement.store.attempt(request.attempt_id).state).toBe('interrupted');
    expect((await f.stats()).count).toBe(1);
    expect(replacement.store.usage.summary(session.id)).toMatchObject({
      observations: 1,
      unknown_observations: 1,
    });
    await replacement.supervisor.start(session.id);
    const actor = await control(replacement, session.id, true);
    writeFileSync(join(f.dir, 'provider-mode'), 'text');
    const continued = replacement.store.accept(
      session.id,
      'explicit-continuation',
      replacement.store.session(session.id).revision,
      'Continue with a greeting',
      actor,
      request.attempt_id,
    );
    await until(
      () => replacement!.store.attempt(continued.attempt_id),
      (a) => a.state === 'completed',
    );
    expect((await f.stats()).count).toBe(2);
    expect(replacement.store.usage.summary(session.id)).toMatchObject({
      observations: 2,
      unknown_observations: 1,
      estimated_observations: 1,
    });
    expect(replacement.store.session(session.id).epoch).toBe(2);
  } finally {
    if (daemon?.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      daemon.kill('SIGKILL');
      await exited;
    }
    await replacement?.close();
    await f.close();
  }
});

test.each([
  ['openai', 'openai-responses'],
  ['deepseek', 'openai-completions'],
  ['google', 'google-generative-ai'],
  ['mistral', 'mistral-conversations'],
])('%s retains unknown usage when a successful response omits receipts', async (provider, api) => {
  const f = await setup(provider, api, 'missing-usage');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const request = await submit(f.service, session.id, 'Reply without a usage receipt');
    await until(
      () => f.service.store.attempt(request.attempt_id),
      (a) => a.state === 'completed',
    );
    expect((await f.stats()).count).toBe(1);
    expect(f.service.store.usage.summary(session.id)).toMatchObject({
      observations: 1,
      unknown_observations: 1,
      estimated_observations: 0,
    });
  } finally {
    await f.close();
  }
});

test('a changed Azure endpoint is denied before dispatch from an already bound session', async () => {
  const f = await setup('azure', 'azure-openai-responses', 'text');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await f.credentials.modify('azure', async () => ({
      type: 'api_key',
      key: 'fixture-provider-key',
      env: { AZURE_OPENAI_RESOURCE_NAME: 'changed' },
    }));
    await submit(f.service, session.id, 'Do not send context to a changed endpoint');
    await until(
      () => f.service.supervisor.inspect(session.id).state,
      (s) => s === 'unhealthy',
    );
    expect((await f.stats()).count).toBe(0);
    expect(f.service.store.usage.summary(session.id)).toMatchObject({ observations: 0 });
    expect(f.service.store.providerRoute(session.id)?.connection?.endpoint).toContain(
      'fixture.openai.azure.com',
    );
  } finally {
    await f.close();
  }
});

test('Bedrock IAM credentials sign locally and reach the same gated dispatch path', async () => {
  const f = await setup('amazon-bedrock', 'bedrock-converse-stream', 'text');
  try {
    await f.credentials.modify('amazon-bedrock', async () => ({ type: 'api_key' }));
    Object.assign(f.options.providerEnvironment, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAFIXTURE',
      AWS_SECRET_ACCESS_KEY: 'fixture-aws-signing-secret',
    });
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const request = await submit(f.service, session.id, 'Reply using fixture IAM credentials');
    const final = await until(
      () => f.service.store.attempt(request.attempt_id),
      (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
    );
    expect(final).toMatchObject({ state: 'completed', result: 'Provider fixture complete.' });
    const stats = await f.stats();
    expect(stats.count).toBe(1);
    expect(stats.bodies[0]?.sigv4).toBe(true);
    expect(JSON.stringify(f.service.store.snapshot(session.id))).not.toContain(
      'fixture-aws-signing-secret',
    );
  } finally {
    await f.close();
  }
});

test('Vertex ADC exchanges a fixture file credential locally before gated model dispatch', async () => {
  const f = await setup(
    'google-vertex',
    'google-vertex',
    'text',
    false,
    async (credentials, dir) => {
      const subject = join(dir, 'subject-token'),
        credential = join(dir, 'adc.json');
      writeFileSync(subject, 'fixture-subject-token', { mode: 0o600 });
      const port = readFileSync(join(dir, 'provider-port'), 'utf8');
      writeFileSync(
        credential,
        JSON.stringify({
          type: 'external_account',
          audience:
            '//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/fixture/providers/fixture',
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          token_url: 'http://127.0.0.1:' + port + '/token',
          credential_source: { file: subject },
        }),
        { mode: 0o600 },
      );
      await credentials.modify('google-vertex', async () => ({
        type: 'api_key',
        env: {
          GOOGLE_CLOUD_PROJECT: 'fixture',
          GOOGLE_CLOUD_LOCATION: 'global',
          GOOGLE_APPLICATION_CREDENTIALS: credential,
        },
      }));
    },
  );
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const request = await submit(f.service, session.id, 'Reply using fixture ADC');
    const final = await until(
      () => f.service.store.attempt(request.attempt_id),
      (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
    );
    expect(
      final,
      JSON.stringify({
        final,
        session: f.service.store.session(session.id).error,
        stats: await f.stats(),
      }),
    ).toMatchObject({ state: 'completed', result: 'Provider fixture complete.' });
    const stats = await f.stats();
    expect(stats.count).toBe(1);
    expect(stats.auth_count).toBeGreaterThan(0);
    expect(stats.bodies[0]?.authenticated).toBe(true);
    expect(JSON.stringify(f.service.store.snapshot(session.id))).not.toContain(
      'fixture-subject-token',
    );
  } finally {
    await f.close();
  }
});

test('changing output-cap capabilities requires restart before another interactive request', async () => {
  const f = await setup('openai', 'openai-responses', 'text');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await f.credentials.modify('openai', async () => ({
      type: 'oauth',
      access: 'fixture-subscription-token',
      refresh: 'fixture-refresh',
      expires: Date.now() + 3600000,
    }));
    await submit(f.service, session.id, 'Do not silently remove the visible output limit');
    await until(
      () => f.service.supervisor.inspect(session.id).state,
      (s) => s === 'unhealthy',
    );
    expect((await f.stats()).count).toBe(0);
    expect(f.service.supervisor.providerCapabilities().output_token_cap).toBe(true);
    expect(f.service.store.session(session.id).error).toContain('restart');
  } finally {
    await f.close();
  }
});

test.each(['openai', 'openai-codex'])(
  '%s OAuth children share request reservations without a token cap',
  async (provider) => {
    const api = provider === 'openai' ? 'openai-responses' : 'openai-codex-responses';
    const f = await setup(provider, api, 'child', true);
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      const actor = await control(f.service, session.id);
      const plan = {
        objective: 'Delegate read-only work',
        constraints: [],
        limits: { token_units: null, requests: 3 },
        steps: [
          {
            key: 'one',
            title: 'Delegate',
            instruction: 'Spawn a child then reply',
            depends_on: [],
          },
        ],
      };
      const task = f.service.taskWork.create(session.id, 'create-child-task', 0, plan, actor);
      const accepted = f.service.taskWork.run(
        task.id,
        task.steps[0]!.id,
        'run-child-task',
        task.revision,
        null,
        null,
        actor,
      );
      await until(
        () => f.service.store.attempt(accepted.attempt_id),
        (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
      );
      expect(f.service.store.attempt(accepted.attempt_id)).toMatchObject({ state: 'completed' });
      const children = f.service.children.list(session.id);
      expect(children).toHaveLength(1);
      expect(children[0]!.state).toBe('completed');
      expect(f.service.taskBudget.state(task.id)).toMatchObject({
        requests_spent: 3,
        reserved_requests: 0,
        token_units: 0,
        reserved_tokens: 0,
      });
      expect((await f.stats()).count).toBe(3);
      await f.restart();
      expect(f.service.children.list(session.id).map((c) => c.id)).toEqual(
        children.map((c) => c.id),
      );
      expect((await f.stats()).count).toBe(3);
    } finally {
      await f.close();
    }
  },
);

test('switching to subscription auth requires an existing capped plan to explicitly opt out before any task dispatch', async () => {
  const f = await setup('openai', 'openai-responses', 'text');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    let actor = await control(f.service, session.id);
    const plan = {
      objective: 'Preserve requested caps',
      constraints: [],
      steps: [{ key: 'one', title: 'One', instruction: 'Reply', depends_on: [] }],
    };
    let task = f.service.taskWork.create(session.id, 'create-capped', 0, plan, actor);
    await f.credentials.modify('openai', async () => ({
      type: 'oauth',
      access: 'fixture-provider-key.subscription.token',
      refresh: 'fixture',
      expires: Date.now() + 3600000,
    }));
    await f.restart();
    actor = await control(f.service, session.id, true);
    expect(() =>
      f.service.taskWork.run(
        task.id,
        task.steps[0]!.id,
        'blocked-cap',
        task.revision,
        null,
        null,
        actor,
      ),
    ).toThrow('no output cap');
    expect((await f.stats()).count).toBe(0);
    expect(f.service.store.snapshot(session.id).attempts).toHaveLength(0);
    expect(
      f.service.taskWork.create(session.id, 'create-capped', 0, plan, {
        client_id: 'expired',
        token: 'expired',
      }).id,
    ).toBe(task.id);
    task = f.service.taskWork.revise(
      task.id,
      'explicit-opt-out',
      task.revision,
      { ...plan, limits: { token_units: null } },
      actor,
    );
    await f.service.supervisor.start(session.id);
    const accepted = f.service.taskWork.run(
      task.id,
      task.steps[0]!.id,
      'allowed-uncapped',
      task.revision,
      null,
      null,
      actor,
    );
    await until(
      () => f.service.store.attempt(accepted.attempt_id),
      (a) => a.state === 'completed',
    );
    expect((await f.stats()).count).toBe(1);
  } finally {
    await f.close();
  }
});

test('local subscription model selection retains its uncapped capability on a capped daemon and rejects an explicit cap', async () => {
  const f = await setup('openai', 'openai-responses', 'tool', true);
  const selected = { provider: 'openai', model: f.service.supervisor.route.model };
  const { call } = await import('../../src/transport.js');
  try {
    f.options.providerRoute = providerRoute();
    await f.restart();
    expect(f.service.supervisor.providerCapabilities().output_token_cap).toBe(true);
    await expect(
      call(f.service.socket, '/v1/sessions', {
        request_id: randomUUID(),
        cwd: f.dir,
        local_workspace: true,
        route: { ...selected, max_tokens: 4096 },
      }),
    ).rejects.toThrow('cannot enforce');
    const session = await call<import('../../src/protocol.js').Session>(
      f.service.socket,
      '/v1/sessions',
      { request_id: randomUUID(), cwd: f.dir, local_workspace: true, route: selected },
    );
    await ready(f.service, session.id);
    expect(f.service.supervisor.inspect(session.id).provider_capabilities?.output_token_cap).toBe(
      false,
    );
    expect(f.service.store.localOutputCap(session.id)).toBe(false);
    await f.restart();
    await f.service.supervisor.start(session.id);
    expect(f.service.supervisor.inspect(session.id).provider_capabilities?.output_token_cap).toBe(
      false,
    );
    expect((await f.stats()).count).toBe(0);
  } finally {
    await f.close();
  }
}, 30000);
