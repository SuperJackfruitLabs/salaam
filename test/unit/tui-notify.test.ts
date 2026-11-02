import { test, expect } from 'vitest';
import { notificationFor, notify, notifyMode, jobsText } from '../../src/tui/notify.js';
import type { DurableEvent } from '../../src/core/protocol.js';

const ev = (kind: string, payload: unknown = {}) =>
  ({ kind, payload, seq: 1 }) as unknown as DurableEvent;

test('only approvals, turn ends and background exits notify', () => {
  expect(notificationFor(ev('approval.requested'))).toMatch(/approval/);
  expect(notificationFor(ev('attempt.completed'))).toMatch(/finished/);
  expect(
    notificationFor(
      ev('local.task_finished', { state: 'exited', exit_code: 2, command: 'npm run dev' }),
    ),
  ).toBe('Background command exited with 2: npm run dev');
  expect(notificationFor(ev('tool.started'))).toBeNull();
});

test('the mode is bell by default; desktop passes the message as an argument, never as script', () => {
  expect(notifyMode({})).toBe('bell');
  expect(notifyMode({ SALAAM_NOTIFY: 'off' })).toBe('off');
  const runs: [string, string[]][] = [];
  const bells: string[] = [];
  const msg = 'x" & do shell script "touch /tmp/pwn';
  notify(
    msg,
    'desktop',
    'darwin',
    (c, a) => runs.push([c, a]),
    (s) => bells.push(s),
  );
  expect(bells).toEqual(['\x07']);
  expect(runs[0]![0]).toBe('osascript');
  expect(runs[0]![1].at(-1)).toBe(msg);
  expect(runs[0]![1][1]).not.toContain('pwn');
  notify(
    msg,
    'desktop',
    'linux',
    (c, a) => runs.push([c, a]),
    () => {},
  );
  expect(runs[1]).toEqual(['notify-send', ['Salaam', msg]]);
  notify(
    msg,
    'off',
    'linux',
    (c, a) => runs.push([c, a]),
    (s) => bells.push(s),
  );
  expect(runs).toHaveLength(2);
  expect(bells).toHaveLength(1);
});

test('the jobs list shows each task’s state and its last lines', () => {
  const text = jobsText(
    [{ id: 'task_1', command: 'npm run dev', state: 'running', exit_code: null, started_at: '' }],
    [{ output: 'a\nready on :3000\n' }],
  );
  expect(text).toContain('task_1  running  npm run dev');
  expect(text).toContain('│ ready on :3000');
});
