import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setCapabilityOverrides, visibleWidth } from '@earendil-works/pi-tui';
import { remoteArguments, shellQuote } from '../../src/remote.js';
import { editorArguments } from '../../src/tui.js';
import { ChoiceModal, ApprovalModal } from '../../src/tui-modals.js';
import { SalaamTheme, safeText } from '../../src/tui-theme.js';
import type { Approval, Operation } from '../../src/protocol.js';

test('remote argv quotes literal shell characters and rejects flag/control hosts', () => {
  const path = "/tmp/owned '$HOME;$(false)`false` 🌿";
  const args = remoteArguments({
    host: 'example',
    state: path,
    executable: '/tmp/sal',
    session: '12345678-1234-1234-1234-123456789abc',
  });
  const command = args.at(-1)!;
  expect(
    execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s' "$4"`], { encoding: 'utf8' }),
  ).toBe(path);
  expect(
    execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(path)}`], { encoding: 'utf8' }),
  ).toBe(path);
  for (const host of ['-oProxyCommand=evil', 'a;evil', 'a\nb', 'a b'])
    expect(() => remoteArguments({ host })).toThrow();
  expect(() => remoteArguments({ host: 'safe', observe: true, takeover: true })).toThrow();
  expect(args).toContain('ForwardAgent=no');
  expect(args).toContain('ClearAllForwardings=yes');
});
test('editor arguments keep quoted paths literal and never expand shell syntax', () => {
  expect(editorArguments("'/Applications/My Editor/bin/editor' --wait '$HOME;$(false)' ")).toEqual([
    '/Applications/My Editor/bin/editor',
    '--wait',
    '$HOME;$(false)',
  ]);
  expect(() => editorArguments('editor "unterminated')).toThrow();
});
test('palette filters visible names, targets and saved identifiers', () => {
  const chosen: string[] = [];
  const modal = new ChoiceModal(
    'Test',
    [{ value: 'opaque-id', label: 'Take control', description: 'Retain work' }],
    new SalaamTheme('night', false),
    () => {},
    () => {},
    (item) => chosen.push(item.value),
    () => 40,
  );
  for (const key of 'Take control') modal.handleInput(key);
  expect(modal.render(72).join('\n')).toContain('Take control');
  modal.handleInput('\r');
  expect(chosen).toEqual(['opaque-id']);
});
test('terminal text strips control injection and both themes respect cell widths', () => {
  expect(safeText('\x1b]52;c;ZXZpbA==\x07hello\x1b[2J\u202e\x00')).toBe('hello');
  for (const name of ['night', 'paper'] as const) {
    const t = new SalaamTheme(name, true);
    expect(visibleWidth(t.line('🌿 नमस्ते', 20))).toBe(20);
    expect(visibleWidth(t.line('long'.repeat(100), 10))).toBe(10);
  }
});
test('approval cannot approve before full review or after its binding changes', () => {
  const a = {
    id: 'a',
    operation_digest: 'digest',
    revision: 1,
    worker_epoch: 1,
    state: 'pending',
    expires_at: Date.now() + 60000,
  } as Approval;
  const op = {
    kind: 'review',
    target: 'reviewed target',
    value: 'full value\n'.repeat(40),
    target_version: 'v1',
  } as Operation;
  const decisions: string[] = [];
  let current: Approval | undefined = a;
  const modal = new ApprovalModal(
    a,
    op,
    new SalaamTheme('night', false),
    () => 20,
    () => current,
    () => {},
    () => {},
    (decision) => decisions.push(decision),
  );
  modal.render(64);
  modal.handleInput('\x1b[C');
  modal.handleInput('\r');
  expect(decisions).toEqual([]);
  modal.handleInput('\x1b[F');
  modal.render(64);
  modal.handleInput('\r');
  expect(decisions).toEqual(['approve']);
  current = { ...a, revision: 2 };
  modal.render(64);
  modal.handleInput('\r');
  expect(decisions).toEqual(['approve']);
});

test('indexed palettes preserve distinct surfaces when SSH does not advertise true color', () => {
  setCapabilityOverrides({ trueColor: false });
  try {
    for (const name of ['night', 'paper'] as const) {
      const t = new SalaamTheme(name, true);
      const bg = t.fill('', 20),
        panel = t.fill('', 20, 'panel');
      expect(bg).toContain(name === 'night' ? '48;5;233' : '48;5;255');
      expect(panel).toContain(name === 'night' ? '48;5;234' : '48;5;254');
      expect(bg).not.toBe(panel);
      expect(visibleWidth(bg)).toBe(20);
    }
  } finally {
    setCapabilityOverrides({ trueColor: undefined });
  }
});
