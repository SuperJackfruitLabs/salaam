import { test, expect } from 'vitest';
import { ProviderUsageReceipt } from '../../src/providers/usage.js';
import { providerRoute } from '../../src/providers/config.js';

test('missing usage and an initial Anthropic output zero remain unknown', () => {
  const receipt = new ProviderUsageReceipt();
  receipt.observe('anthropic-messages', {
    type: 'message_start',
    message: { usage: { input_tokens: 12, output_tokens: 0 } },
  });
  expect(receipt.complete).toBe(false);
  receipt.observe('anthropic-messages', { type: 'message_delta', usage: { output_tokens: 0 } });
  expect(receipt.complete).toBe(true);
  const missing = new ProviderUsageReceipt();
  missing.observe('openai-completions', { choices: [{ finish_reason: 'stop' }] });
  expect(missing.complete).toBe(false);
  missing.observe('openai-completions', { usage: { prompt_tokens: 0, completion_tokens: 0 } });
  expect(missing.complete).toBe(true);
});

test('a rejected live request transcript cannot create a usage admission; dispatched unknown work remains charged', async () => {
  const { Store } = await import('../../src/store/store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = mkdtempSync('/tmp/sal-rejected-usage-');
  const store = new Store(join(dir, 'journal.sqlite'));
  try {
    const session = store.create(dir, 'create');
    store.bindRoute(session.id, providerRoute('openai', 'gpt-4', 512));
    const epoch = store.allocate(session.id, 'boot');
    const entries = [
      {
        id: 'rejected',
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'openai',
          model: 'gpt-4',
          responseId: 'salaam-request:rejected',
          stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ];
    store.importEntries(session.id, epoch, entries, 'rejected');
    store.importEntries(session.id, epoch, entries, 'rejected');
    expect(store.usage.summary(session.id)).toMatchObject({ observations: 0 });
    store.usage.admit(session.id, undefined, 'salaam-request:rejected', 'openai', 'gpt-4');
    store.importEntries(session.id, epoch, entries, 'rejected');
    expect(store.usage.summary(session.id)).toMatchObject({
      observations: 1,
      unknown_observations: 1,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reimporting a completed Pi message cannot turn an unreceipted managed request into zero spend', async () => {
  const { Store } = await import('../../src/store/store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = mkdtempSync('/tmp/sal-unknown-usage-'),
    store = new Store(join(dir, 'journal.sqlite'));
  try {
    const session = store.create(dir, 'create'),
      epoch = store.allocate(session.id, 'boot');
    store.usage.admit(session.id, undefined, 'salaam-request:missing', 'openai', 'gpt-4');
    const entries = [
      {
        id: 'missing',
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'openai',
          model: 'gpt-4',
          responseId: 'salaam-request:missing',
          stopReason: 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ];
    store.importEntries(session.id, epoch, entries, 'missing');
    store.importEntries(session.id, epoch, entries, 'missing');
    expect(store.usage.summary(session.id)).toMatchObject({
      observations: 1,
      unknown_observations: 1,
      estimated_observations: 0,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
