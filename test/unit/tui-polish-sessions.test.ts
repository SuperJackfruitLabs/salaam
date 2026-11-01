import { test, expect } from 'vitest';
import { SalaamApp } from '../../src/tui/app.js';
import type { ChoiceModal } from '../../src/tui/modals.js';
import type { Session } from '../../src/core/protocol.js';

// Trial polish C (2026-10-31): the session picker puts this folder's sessions first with what you
// last asked and when; `salaam code --continue` in a folder with no session says it started one.
const session = (id: string, cwd: string, extra: Partial<Session> = {}) =>
  ({ id, cwd, state: 'ready', capabilities: [], ...extra }) as unknown as Session;

function app(cwd: string) {
  const a = new SalaamApp({ state: '/tmp/salaam-polish-c', cwd });
  const shown: unknown[] = [];
  const internal = a as unknown as {
    showModal: (c: unknown, w?: number) => void;
    sessions(): Promise<void>;
    openHere(start: 'continue' | 'new' | 'resume'): Promise<void>;
    startService(): Promise<void>;
    setTab(t: string): void;
  };
  internal.showModal = (c) => void shown.push(c);
  return { a, internal, shown };
}

test('the picker lists this folder first with the last prompt and its age', async () => {
  const now = Date.now();
  const { a, internal, shown } = app('/w/app');
  a.client.list = async () => {
    a.client.sessions = [
      session('11111111-0000-0000-0000-000000000000', '/w/other', {
        last_active_at: new Date(now - 1000).toISOString(),
      }),
      session('22222222-0000-0000-0000-000000000000', '/w/app', {
        last_prompt: 'fix the help line',
        last_active_at: new Date(now - 180_000).toISOString(),
      }),
    ];
  };
  await internal.sessions();
  const modal = shown.at(-1) as ChoiceModal;
  const items = (modal as unknown as { items: { value: string; description?: string }[] }).items;
  expect(items.map((i) => i.value)).toEqual([
    'new',
    '22222222-0000-0000-0000-000000000000',
    '11111111-0000-0000-0000-000000000000',
  ]);
  expect(items[1]!.description).toBe('“fix the help line” · 3 min ago · /w/app');
});

test('continuing a folder with no session starts one and says so', async () => {
  const { a, internal } = app('/w/fresh');
  internal.startService = async () => {};
  internal.setTab = () => {};
  a.client.sessions = [session('33333333-0000-0000-0000-000000000000', '/w/other')];
  const created: string[] = [];
  a.client.create = (async (cwd: string) => {
    created.push(cwd);
    return 's-new';
  }) as unknown as typeof a.client.create;
  await internal.openHere('continue');
  expect(created).toEqual(['/w/fresh']);
  expect(a.client.notice).toMatch(/No earlier session in this folder/);
  a.client.notice = '';
  await internal.openHere('new');
  expect(a.client.notice).toBe('');
});

test('the window title and Herdr follow the session state, and stay quiet when turned off', () => {
  const titles: string[] = [];
  const reports: string[] = [];
  const make = (env: Record<string, string>) => {
    const old = process.env.SALAAM_TERMINAL_STATUS;
    if (env.SALAAM_TERMINAL_STATUS) process.env.SALAAM_TERMINAL_STATUS = env.SALAAM_TERMINAL_STATUS;
    else delete process.env.SALAAM_TERMINAL_STATUS;
    const { a } = app('/w/app');
    if (old === undefined) delete process.env.SALAAM_TERMINAL_STATUS;
    else process.env.SALAAM_TERMINAL_STATUS = old;
    a.terminal.setTitle = (t: string) => void titles.push(t);
    (a as unknown as { herdr: { report(s: string, id?: string): void } }).herdr = {
      report: (s, id) => void reports.push(s + ' ' + id),
    };
    return a;
  };
  const a = make({});
  a.client.names['s1'] = 'app';
  const changed = () => (a as unknown as { changed(): void }).changed();
  a.client.snapshot = {
    id: 's1',
    cwd: '/w/app',
    capabilities: [],
    submissions: [],
    attempts: [{ id: 'x', state: 'running' }],
    approvals: [{ id: 'p', state: 'pending' }],
    operations: [],
    messages: [],
  } as unknown as import('../../src/core/protocol.js').SessionSnapshot;
  changed();
  expect(titles.at(-1)).toBe('Salaam · app · needs you');
  expect(reports.at(-1)).toBe('blocked s1');
  const count = titles.length;
  changed();
  expect(titles).toHaveLength(count);
  titles.length = 0;
  reports.length = 0;
  const off = make({ SALAAM_TERMINAL_STATUS: 'off' });
  off.client.snapshot = a.client.snapshot;
  (off as unknown as { changed(): void }).changed();
  expect(titles).toEqual([]);
  expect(reports).toEqual([]);
});
