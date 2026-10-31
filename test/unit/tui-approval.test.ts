import { test, expect } from 'vitest';
import { ApprovalModal, onceOnlyReason } from '../../src/tui-modals.js';
import { SalaamTheme } from '../../src/tui-theme.js';
import type { Approval, Operation } from '../../src/protocol.js';

// Phase 2a: the approval prompt reads in plain words, keeps internals behind a details toggle, and in
// desk sessions offers once / for this session / always for this repo / deny from the keyboard.
const strip = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
function modal(
  offerRules: boolean,
  value = 'Runs as your local user, in a bubblewrap sandbox\nCommand:\nnpm test',
  onceOnly?: string,
) {
  const a = {
    id: 'approval-uuid-1234',
    operation_digest: 'digest-abcdef',
    revision: 3,
    worker_epoch: 1,
    state: 'pending',
    expires_at: Date.now() + 60000,
  } as Approval;
  const op = {
    kind: 'workspace',
    target: 'Local command: /work/repo',
    value,
    target_version: 'v9',
  } as Operation;
  const decisions: string[] = [];
  let current: Approval | undefined = a;
  const m = new ApprovalModal(
    a,
    op,
    new SalaamTheme('night', false),
    () => 30,
    () => current,
    () => {},
    () => {},
    (d) => decisions.push(d),
    offerRules,
    onceOnly,
  );
  return { m, decisions, setCurrent: (c: Approval | undefined) => (current = c) };
}
test('the prompt shows what runs in plain words; ids, digests and expiry only behind details', () => {
  const { m } = modal(true);
  const plain = strip(m.render(80));
  expect(plain).toContain('npm test');
  expect(plain).toContain('Local command: /work/repo');
  for (const internal of [
    'approval-uuid-1234',
    'digest-abcdef',
    'Revision',
    'Expires',
    'worker epoch',
  ])
    expect(plain).not.toContain(internal);
  m.handleInput('d');
  const details = strip(m.render(80));
  expect(details).toContain('approval-uuid-1234');
  expect(details).toContain('digest-abcdef');
});
test('desk sessions get four choices from the keyboard; others get approve once or deny', () => {
  const desk = strip(modal(true).m.render(80));
  for (const choice of [
    'Approve once',
    'Approve for this session',
    'Always allow in this repo',
    'Deny',
  ])
    expect(desk).toContain(choice);
  const strict = strip(modal(false).m.render(80));
  expect(strict).toContain('Approve once');
  expect(strict).not.toContain('Approve for this session');
  expect(strict).not.toContain('Always allow');
  for (const [key, want] of [
    ['y', 'approve'],
    ['s', 'approve-session'],
    ['a', 'always'],
    ['n', 'deny'],
  ] as const) {
    const { m, decisions } = modal(true);
    m.render(80);
    m.handleInput(key);
    expect(decisions, key).toEqual([want]);
  }
  // Without rules, s and a do nothing.
  const { m, decisions } = modal(false);
  m.render(80);
  m.handleInput('s');
  m.handleInput('a');
  expect(decisions).toEqual([]);
});
test('a long request still has to be read to the end before any approval, and a changed one is refused', () => {
  const { m, decisions, setCurrent } = modal(true, 'line\n'.repeat(80));
  m.render(80);
  m.handleInput('y');
  m.handleInput('s');
  m.handleInput('a');
  expect(decisions).toEqual([]);
  m.handleInput('n');
  expect(decisions).toEqual(['deny']);
  const second = modal(true, 'line\n'.repeat(80));
  second.m.render(80);
  second.m.handleInput('\x1b[F');
  second.m.render(80);
  second.setCurrent(undefined);
  second.m.render(80);
  second.m.handleInput('y');
  expect(second.decisions).toEqual([]);
});

test('a command that can never become a rule offers only approve once and deny, and says why', () => {
  const piped = 'Runs as your local user, in a Seatbelt sandbox\nCommand:\nnpm test 2>&1 | tail -5';
  const reason = onceOnlyReason(piped);
  expect(reason).toMatch(/cannot become a rule/);
  expect(onceOnlyReason('Runs as your local user\nCommand:\nnpm test -- a.ts')).toBeUndefined();
  // Edits are not commands: their rule choices stay.
  expect(onceOnlyReason('Edit src/a.ts\n@@ -1 +1 @@')).toBeUndefined();
  const shown = strip(modal(false, piped, reason).m.render(80));
  expect(shown).toContain('cannot become a rule');
  expect(shown).toContain('Approve once');
  expect(shown).toContain('Deny');
  expect(shown).not.toContain('Approve for this session');
  expect(shown).not.toContain('Always allow');
});
