import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setCapabilityOverrides, visibleWidth } from '@earendil-works/pi-tui';
import { remoteArguments, shellQuote } from '../../src/remote.js';
import { editorArguments, SalaamApp } from '../../src/tui.js';
import { ChoiceModal, ApprovalModal } from '../../src/tui-modals.js';
import { SalaamTheme, safeText } from '../../src/tui-theme.js';
import type { Approval, Operation, SessionSnapshot } from '../../src/protocol.js';

test('context stays at the top when a short conversation grows or its first snapshot arrives', () => {
  const app = new SalaamApp({ state: '/tmp/salaam-scroll-proof' });
  app.scroll.updateLayout(10, 30, () => {});
  app.setTab('context');
  app.scroll.updateLayout(300, 30, () => {});
  expect(app.scroll.scrollTop).toBe(0);
  expect(app.scroll.isFollowingEnd).toBe(false);

  app.client.snapshot = { id: 'first-session', submissions: [] } as unknown as SessionSnapshot;
  app.client.emit('change');
  app.scroll.updateLayout(300, 30, () => {});
  expect(app.scroll.scrollTop).toBe(0);

  app.setTab('conversation');
  expect(app.scroll.scrollTop).toBe(270);
  expect(app.scroll.isFollowingEnd).toBe(true);
});

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

test('task context labels a disabled token budget instead of showing a numeric allowance', () => {
  const app = new SalaamApp({ state: '/tmp/salaam-token-budget-display' });
  app.client.snapshot = {
    id: 'session',
    epoch: 1,
    state: 'ready',
    children: [],
    work_task: {
      id: 'task',
      revision: 1,
      plan_revision: 1,
      state: 'accepted',
      objective: 'Review work',
      reason: 'Waiting',
      constraints: [],
      steps: [],
      limits: { requests: 3, token_units: null, output_token_bound: null },
      runtime: { requests_spent: 0, reserved_requests: 0, token_units: 0, reserved_tokens: 0 },
    },
  } as unknown as SessionSnapshot;
  app.setTab('context');
  const text = app.document.render(100).join('\n');
  expect(text).toContain('Token budget disabled');
  expect(text).toContain('no task output-token bound');
  expect(text).not.toContain('Declared token units');
});

test('mixed team stays visible before long verification history, with compact current and historical checks', () => {
  const app = new SalaamApp({ state: '/tmp/salaam-mixed-context' });
  app.client.snapshot = {
    id: 'session',
    epoch: 1,
    state: 'exited',
    children: [],
    team: {
      assignments: [
        {
          id: 'assignment',
          profile_id: 'salaam/builder',
          generation: 1,
          step_state: 'completed',
          stale: false,
          runtime: { id: 'codex' },
          execution: { state: 'completed', stopped: true },
        },
      ],
      messages: [],
    },
    work_task: {
      id: 'task',
      revision: 20,
      plan_revision: 1,
      state: 'succeeded',
      objective: 'Review integrated change',
      reason: 'Verified',
      constraints: [],
      steps: [],
      limits: { requests: 40, token_units: null },
      verification: {
        checks: Array.from({ length: 20 }, (_, i) => ({
          id: 'check-' + i,
          check_key: 'suite',
          state: i ? 'failed' : 'passed',
          fresh: i === 0,
          workspace_revision: i ? 0 : 1,
          artifact_id: 'verbose-private-receipt-field',
        })),
        completion: { state: 'succeeded', fresh: true },
      },
    },
  } as unknown as SessionSnapshot;
  app.setTab('context');
  const text = app.document.render(140).join('\n');
  expect(text.indexOf('TEAM BOARD')).toBeLessThan(text.indexOf('VERIFICATION'));
  expect(text).toContain('suite · passed · current · r1');
  expect(text).toContain('suite · failed · historical · r0');
  expect(text).toContain('Task succeeded · current verification');
  expect(text).not.toContain('verbose-private-receipt-field');
});
