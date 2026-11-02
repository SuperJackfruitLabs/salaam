import { test, expect } from 'vitest';
import { ApprovalModal, approvalReason } from '../../src/tui/modals.js';
import { toolLine, progressLine, activityVerb } from '../../src/tui/activity.js';
import { SalaamTheme } from '../../src/tui/theme.js';
import type { Approval, Operation } from '../../src/core/protocol.js';

// Trial polish track A: approvals open on Approve once, can be denied with a reason, say why they
// ask, and show desk edits as a diff without a read-to-the-end gate; tool calls read as one line.
const strip = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
function modal(value: string, desk: boolean, reason?: string) {
  const a = {
    id: 'approval-1',
    operation_digest: 'digest-1',
    revision: 1,
    worker_epoch: 1,
    state: 'pending',
    expires_at: Date.now() + 60000,
  } as Approval;
  const op = {
    kind: 'workspace',
    target: 'Local edit: /work/repo',
    value,
    target_version: 'v1',
  } as Operation;
  const decisions: string[] = [];
  const m = new ApprovalModal(
    a,
    op,
    new SalaamTheme('night', false),
    () => 30,
    () => a,
    () => {},
    () => {},
    (d) => decisions.push(d),
    desk,
    undefined,
    { desk, reason },
  );
  return { m, decisions };
}
const longDiff = [
  '--- src/a.ts',
  '+++ src/a.ts',
  '@@ -1,3 +1,3 @@',
  ...Array.from({ length: 60 }, (_, i) => ' ctx ' + i),
  '-old',
  '+new',
].join('\n');

test('focus starts on Approve once, so Enter approves once', () => {
  const { m, decisions } = modal('Command:\nnpm test', true);
  expect(strip(m.render(80))).toMatch(/› y {2}Approve once/);
  m.handleInput('\r');
  expect(decisions).toEqual(['approve']);
});
test('a desk edit can be approved without scrolling to the end; strict work keeps the gate', () => {
  const desk = modal(longDiff, true);
  const shown = strip(desk.m.render(80));
  expect(shown).not.toContain('Read to the end');
  expect(shown).toMatch(/more lines · ↓ to scroll/);
  desk.m.handleInput('y');
  expect(desk.decisions).toEqual(['approve']);
  const strict = modal(longDiff, false);
  expect(strip(strict.m.render(80))).toContain('Read to the end');
  strict.m.handleInput('y');
  expect(strict.decisions).toEqual([]);
});
test('Deny and tell it why is one key away', () => {
  const { m, decisions } = modal('Command:\nnpm test', true);
  expect(strip(m.render(80))).toContain('Deny and tell it why');
  m.handleInput('f');
  expect(decisions).toEqual(['deny-feedback']);
});
test('every approval says in one line why it asks', () => {
  expect(
    approvalReason('Dangerous (git-history): git: rewrites history\nCommand:\ngit push -f', 'auto'),
  ).toBe('Asks because this command is dangerous (git-history): git: rewrites history');
  expect(approvalReason('Command:\nnpm test', 'review')).toMatch(
    /review mode asks before every edit and command/i,
  );
  expect(approvalReason('Command:\nnpm test', 'accept-edits')).toMatch(
    /accept edits still asks before commands/i,
  );
  expect(approvalReason('--- a\n+++ a', 'review')).toMatch(/review mode/i);
  expect(approvalReason('Command:\nnpm test', undefined)).toMatch(/^Asks because/);
  const { m } = modal(
    'Command:\nnpm test',
    true,
    'Asks because review mode asks before every edit and command.',
  );
  expect(strip(m.render(80))).toContain('Asks because review mode');
});
test('a diff is shown with its lines intact and coloured by kind', () => {
  const coloured = new ApprovalModal(
    {
      id: 'a',
      operation_digest: 'd',
      revision: 1,
      worker_epoch: 1,
      state: 'pending',
      expires_at: Date.now() + 1e5,
    } as Approval,
    {
      kind: 'workspace',
      target: 'Local edit',
      value: '--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new',
      target_version: 'v',
    } as Operation,
    new SalaamTheme('night', true),
    () => 30,
    () => undefined,
    () => {},
    () => {},
    () => {},
    true,
    undefined,
    { desk: true },
  ).render(80);
  const t = new SalaamTheme('night', true);
  const prefix = (ink: string) => ink.slice(0, ink.indexOf('x'));
  expect(coloured.find((l) => l.includes('+new'))).toContain(prefix(t.ink('x', 'jade')));
  expect(coloured.find((l) => l.includes('-old'))).toContain(prefix(t.ink('x', 'red')));
});
test('tool calls read as one compact line each', () => {
  const edit = JSON.stringify({
    action: 'edit',
    edits: [
      { path: 'src/x.ts', sha256: 'abc', replacements: [{ old: 'a\nb', new: 'a\nB\nc\nd' }] },
    ],
  });
  expect(toolLine('salaam_local', edit, undefined).label).toBe('Edit src/x.ts +4 −2');
  expect(toolLine('salaam_local', edit, undefined).state).toBe('running');
  const created = JSON.stringify({
    action: 'edit',
    edits: [{ path: 'n.ts', sha256: null, content: 'x\ny\n' }],
  });
  expect(toolLine('salaam_local', created, {}).label).toBe('Edit n.ts +2 −0 (new)');
  const cmd = JSON.stringify({ action: 'command', command: 'npm test' });
  const ok = toolLine('salaam_local', cmd, {
    output: JSON.stringify({ exit_code: 0, output: 'a\nb\nc\nd\n  \n' }),
  });
  expect(ok.label).toBe('Bash npm test ✓ exit 0');
  expect(ok.tail).toEqual(['b', 'c', 'd']);
  const bad = toolLine('salaam_local', cmd, {
    output: JSON.stringify({ exit_code: 2, output: 'boom' }),
  });
  expect(bad.label).toBe('Bash npm test × exit 2');
  expect(bad.state).toBe('failed');
  // A record cut at 2 KiB still yields its exit code.
  expect(toolLine('salaam_local', cmd, { output: '{"exit_code":1,"output":"aaaa' }).label).toBe(
    'Bash npm test × exit 1',
  );
  expect(toolLine('salaam_files', JSON.stringify({ action: 'read', path: 'a.ts' }), {}).label).toBe(
    'Read file · a.ts',
  );
});
test('the progress line names the activity, counts seconds and says how to interrupt', () => {
  const line = progressLine(
    activityVerb(
      toolLine(
        'salaam_local',
        JSON.stringify({ action: 'command', command: 'npm test' }),
        undefined,
      ),
    ),
    1000,
    13_500,
    '3.4k',
  );
  expect(line).toMatch(/Running npm test… · 12s · 3\.4k tokens · esc to interrupt$/);
  expect(progressLine('Thinking', 0, 125_000)).toMatch(/Thinking… · 2m 5s · esc to interrupt/);
});
