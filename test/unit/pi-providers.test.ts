import { expect, test } from 'vitest';
import { normalizeContext } from '@earendil-works/pi-ai';
import { PI_PROVIDERS, providerRoute } from '../../src/provider-config.js';
import { materialize, generationOptions } from '../../src/provider-model.js';
import { validateProviderPayload } from '../../src/provider-payload.js';

test('every pinned Pi provider and chat model is addressable without network discovery', () => {
  expect(PI_PROVIDERS).toHaveLength(42);
  for (const provider of PI_PROVIDERS)
    for (const model of provider.getModels()) {
      expect(providerRoute(provider.id, model.id, 512)).toMatchObject({
        provider: provider.id,
        model: model.id,
        max_tokens: 512,
      });
    }
  expect(PI_PROVIDERS.find((p) => p.id === 'typesafe')!.getModels()).toHaveLength(0);
  expect(() => providerRoute('typesafe', 'system-one')).toThrow('pinned Pi chat');
});

// Exercise Pi's real serializers, stopping before all network access.
const cases = PI_PROVIDERS.flatMap((provider) => provider.getModels());
test.each(cases.map((m) => ({ name: m.provider + '/' + m.id, model: m })))(
  '$name validates the actual Pi payload before dispatch',
  async ({ model }) => {
    const route = providerRoute(model.provider, model.id, 512);
    let payload: unknown;
    const context = normalizeContext({
      systemPrompt: 'Salaam test',
      messages: [{ role: 'user', content: 'FRAME', timestamp: 1 }],
      tools: [
        {
          name: 'salaam_probe',
          description: 'Probe',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });
    const stream = PI_PROVIDERS.find((p) => p.id === model.provider)!.streamSimple(
      {
        ...model,
        maxTokens: 512,
        compat: {
          ...model.compat,
          supportsMidConvoSystemMessages: false,
          supportsMidConvoToolChanges: false,
          supportsMidConvoEffort: false,
          supportsOpenAIGrammarTools: false,
          allowedFallbackModels: [],
          supportsAdditionalTools: false,
          supportsToolSearch: false,
        },
      },
      context,
      {
        apiKey:
          model.provider === 'openai-codex'
            ? 'fixture.' +
              Buffer.from(
                JSON.stringify({
                  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' },
                }),
              ).toString('base64url') +
              '.signature'
            : model.provider === 'openai'
              ? 'sk-fixture-not-real'
              : 'fixture-key-not-real',
        ...generationOptions(model, context, 512),
        maxRetries: 0,
        transport: 'sse',
        env: {
          AZURE_OPENAI_RESOURCE_NAME: 'fixture',
          CLOUDFLARE_ACCOUNT_ID: 'fixture',
          CLOUDFLARE_GATEWAY_ID: 'fixture',
          GOOGLE_CLOUD_PROJECT: 'fixture',
          GOOGLE_CLOUD_LOCATION: 'global',
        },
        onPayload(value) {
          payload = value;
          throw new Error('fixture-stop-before-network');
        },
      },
    );
    await stream.result();
    expect(payload, model.provider + '/' + model.api).toBeDefined();
    expect(() =>
      validateProviderPayload(
        payload,
        route,
        'FRAME',
        ['salaam_probe'],
        model.provider === 'openai-codex',
      ),
    ).not.toThrow();
    for (const mutation of [
      { model: 'forbidden' },
      { fallbacks: [{ model: 'forbidden' }] },
      { environment: { type: 'local' } },
      { background: true },
    ])
      expect(() =>
        validateProviderPayload({ ...(payload as object), ...mutation }, route, 'FRAME', [
          'salaam_probe',
        ]),
      ).toThrow();
    expect(() =>
      validateProviderPayload(payload, route, 'stale-frame', ['salaam_probe']),
    ).toThrow();
    expect(() => validateProviderPayload(payload, route, 'FRAME', ['foreign-tool'])).toThrow();
  },
);

test('small output caps disable classic thinking and regional endpoints remain in their cloud partitions', async () => {
  const provider = PI_PROVIDERS.find((p) => p.id === 'anthropic')!;
  const model = provider
    .getModels()
    .find(
      (m) =>
        m.reasoning &&
        !(m.compat && 'forceAdaptiveThinking' in m.compat && m.compat.forceAdaptiveThinking),
    )!;
  const context = normalizeContext({
    messages: [{ role: 'user', content: 'FRAME', timestamp: 1 }],
    tools: [],
  });
  let payload: unknown;
  await provider
    .streamSimple({ ...model, maxTokens: 512 }, context, {
      apiKey: 'fixture-key',
      ...generationOptions(model, context, 512),
      onPayload(value) {
        payload = value;
        throw new Error('fixture-stop-before-network');
      },
    })
    .result();
  expect(payload).toMatchObject({ max_tokens: 512 });
  expect((payload as { thinking?: unknown }).thinking).toMatchObject({ type: 'disabled' });
  expect(generationOptions(model, context, 4096).reasoning).toBe('low');
  const bedrock = PI_PROVIDERS.find((p) => p.id === 'amazon-bedrock')!.getModels()[0]!;
  expect(
    materialize(bedrock, { auth: { apiKey: 'fixture' }, env: { AWS_REGION: 'cn-north-1' } })
      .baseUrl,
  ).toBe('https://bedrock-runtime.cn-north-1.amazonaws.com.cn');
  expect(() =>
    materialize(bedrock, { auth: {}, env: { AWS_REGION: 'other.invalid/region' } }),
  ).toThrow('Invalid AWS region');
});
