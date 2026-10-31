import { test, expect } from 'vitest';
import {
  classifierItems,
  classifierNotice,
  type ClassifierView,
} from '../../src/tui-classifier.js';

// Operator 2026-10-31: /classifier picks the reviewer's model like /model, from what the service
// offers, plus Off; a pinned host shows the pin and offers nothing to change.
const view: ClassifierView = {
  configured: true,
  enabled: true,
  choice: 'haiku',
  model: 'claude-haiku-5-5',
  pinned: false,
  options: [
    { name: 'haiku', provider: 'anthropic', model: 'claude-haiku-5-5' },
    { name: 'local', provider: 'openai-compatible', model: 'qwen3-4b' },
  ],
};

test('the picker lists every configured reviewer and Off, marking the current one', () => {
  const items = classifierItems(view);
  expect(items.map((i) => i.value)).toEqual(['haiku', 'local', 'off']);
  expect(items[0]!.label).toMatch(/^● haiku/);
  expect(items[1]!.label).toMatch(/^○ local/);
  expect(items[1]!.description).toContain('openai-compatible · qwen3-4b');
  expect(items[2]!.label).toBe('○ Off');
});

test('a pinned or unconfigured service offers no choices, and the notice says why', () => {
  expect(classifierItems({ ...view, pinned: true })).toEqual([]);
  expect(classifierNotice({ ...view, pinned: true })).toMatch(/pinned by this host/);
  const none = { configured: false, enabled: false, choice: 'off', pinned: false, options: [] };
  expect(classifierItems(none)).toEqual([]);
  expect(classifierNotice(none)).toMatch(/No command reviewer is configured/);
  expect(classifierNotice(view)).toMatch(/haiku \(claude-haiku-5-5\).*only make a command ask/);
  expect(classifierNotice({ ...view, enabled: false, choice: 'off' })).toMatch(
    /off for this session/,
  );
});
