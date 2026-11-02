import { expect, test } from 'vitest';
import type { Component } from '@earendil-works/pi-tui';
import { SalaamApp } from '../../src/tui/app.js';
import { ChoiceModal } from '../../src/tui/modals.js';
import { SLASH_COMMANDS } from '../../src/core/slash-commands.js';
import type { SessionSnapshot } from '../../src/core/protocol.js';

// Phase 6 characterization: every slash command and every Ctrl+K action, run against a fake
// client, with what each one shows, reports, sends and changes recorded. The modularity refactor
// moves these handlers out of app.ts; this record must not change when it does. One level of
// choices is followed, so a menu item that goes nowhere, or somewhere else, shows up here.

// Nothing is ever created here: every call that reaches the service fails the same way.
const STATE = '/tmp/salaam-slash-characterization-state';
const CWD = '/tmp/salaam-slash-characterization-cwd';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const SHOWN_ITEMS = 12;

type Item = { value: string; label: string; description?: string };
type Internal = {
  runSlashCommand(command: string, args?: string): Promise<void>;
  showModal(component: Component, width?: number): void;
  globalActions(): { palette(): void };
};

// JSON keeps the fake loose: a snapshot needs only the fields these handlers read.
const snapshot = (): SessionSnapshot =>
  JSON.parse(
    JSON.stringify({
      id: 'ses_char',
      cwd: CWD,
      state: 'ready',
      epoch: 2,
      revision: 7,
      capabilities: [],
      control: null,
      provider_route: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      submissions: [{ id: 'sub_1', text: 'queued text', state: 'accepted', attempt: 'att_q' }],
      attempts: [
        { id: 'att_run', state: 'running' },
        { id: 'att_int', state: 'interrupted' },
      ],
      messages: [{ entry_id: 'e1', role: 'assistant', text: 'hello', truncated: true }],
      approvals: [{ id: 'apr_1', state: 'pending', operation_id: 'op_1', revision: 2 }],
      operations: [
        {
          id: 'op_1',
          kind: 'workspace',
          target: 'Local command: ls',
          value: 'ls',
          state: 'pending',
        },
      ],
      children: [],
      agents: [],
      work_task: {
        id: 'task_1',
        revision: 3,
        plan_revision: 1,
        state: 'ready',
        objective: 'Fix the bug',
        reason: 'ready',
        constraints: [],
        steps: [
          {
            id: 'step_1',
            key: 'work',
            title: 'Implement',
            instruction: 'Do it',
            depends_on: [],
            checks: ['tests'],
            state: 'pending',
          },
        ],
        acceptance: [{ key: 'tests', command: 'node --test', cwd: '.' }],
        deliverables: [],
        limits: {
          requests: 10,
          runtime_ms: 1000,
          concurrency: 1,
          token_units: null,
          verification_runs: 2,
        },
      },
    }),
  );

const canned: Record<string, unknown> = {
  permissions: {
    configurable: true,
    coding: true,
    policy: { mode: 'review', revision: 4, paths: ['src/'], root: CWD },
    command_sandbox: 'seatbelt',
    full_access_allowed: true,
    yolo_allowed: true,
  },
  hooks: { sources: [] },
  approvalRules: {
    applies: true,
    rules: [{ id: 'r1', effect: 'allow', tool: 'command', command: 'npm test', source: 'session' }],
    problems: [],
  },
  checkpoints: [],
  undoReview: { edits: [{ path: 'a.ts', after: 'new', before: 'old' }] },
  planContext: { files: [], bundles: [] },
  changeReview: null,
  rewind: '',
  review: {
    approval: { id: 'apr_1', state: 'pending', operation_id: 'op_1', revision: 2 },
    operation: { id: 'op_1', kind: 'workspace', target: 'Local command: ls', value: 'ls' },
  },
};
/** The client's own plumbing, which a fake leaves real. */
const REAL = ['constructor', 'report', 'changed', 'tick', 'flush', 'watch', 'acquireOrWait'];

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const plain = (lines: string[]) => lines.map((l) => l.replace(ANSI, '').trimEnd());
const items = (modal: ChoiceModal): Item[] => Reflect.get(modal, 'items');

function fake(session: boolean) {
  const a = new SalaamApp({
    state: STATE,
    cwd: CWD,
    commandsDir: '/tmp/salaam-slash-characterization-commands',
  });
  const record: string[] = [];
  const modals: Component[] = [];
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(a.client))) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(a.client), name);
    if (REAL.includes(name) || typeof descriptor?.value !== 'function') continue;
    Reflect.set(a.client, name, async (...args: unknown[]) => {
      record.push('client.' + name + ' ' + JSON.stringify(args));
      return canned[name];
    });
  }
  a.client.actor = () => ({ client_id: 'cli', token: 'tok' });
  a.client.connection = 'connected';
  if (session) {
    a.client.snapshot = snapshot();
    Object.defineProperty(a.client, 'controlling', { get: () => true });
  }
  const internal: Internal = {
    runSlashCommand: (command, args) => Reflect.get(a, 'runSlashCommand').call(a, command, args),
    showModal: (component, width) => Reflect.get(a, 'showModal').call(a, component, width),
    globalActions: () => Reflect.get(a, 'globalActions').call(a),
  };
  Reflect.set(a, 'showModal', (component: Component, width?: number) => {
    modals.push(component);
    if (component instanceof ChoiceModal) {
      const list = items(component);
      record.push(
        `choice "${component.title}" (${list.length})` + (width ? ' width ' + width : ''),
        ...list
          .slice(0, SHOWN_ITEMS)
          .map((i) => `  ${i.value} | ${i.label}${i.description ? ' | ' + i.description : ''}`),
      );
    } else
      record.push(
        component.constructor.name + (width ? ' width ' + width : ''),
        ...plain(component.render(78)).map((l) => '  ' + l),
      );
  });
  const state = () =>
    [
      `notice: ${a.client.notice}`,
      `tab: ${a.view.tab} · theme ${a.view.theme.name} · rail ${String(Reflect.get(a, 'rail'))}` +
        ` · transcript ${String(a.view.transcript)} · continuation ${String(a.view.continuation)}`,
      `editor: ${a.editor.getExpandedText()}`,
    ].join('\n');
  return { a, internal, record, modals, state };
}

async function attempt(work: () => Promise<void> | void, record: string[]) {
  try {
    await work();
  } catch (error) {
    record.push('threw: ' + (error instanceof Error ? error.message : String(error)));
  }
  await settle();
}

/** Run the entry; then, for each item of the first menu it opens, run it again and pick that item. */
async function sweep(
  session: boolean,
  start: (internal: Internal) => Promise<void> | void,
  skip: string[] = [],
) {
  const first = fake(session);
  await attempt(() => start(first.internal), first.record);
  const out: Record<string, string> = {
    '': first.record.join('\n') + '\n' + first.state(),
  };
  const menu = first.modals.find((m): m is ChoiceModal => m instanceof ChoiceModal);
  if (!menu) return out;
  for (const item of items(menu)) {
    if (skip.includes(item.value)) continue;
    const again = fake(session);
    await attempt(() => start(again.internal), again.record);
    const chosen = again.modals.find((m): m is ChoiceModal => m instanceof ChoiceModal);
    const mark = again.record.length;
    await attempt(() => chosen?.onSelect(item), again.record);
    out['→ ' + item.value] = again.record.slice(mark).join('\n') + '\n' + again.state();
  }
  return out;
}

const ARGS: Record<string, string[]> = {
  help: ['model', 'nope'],
  model: ['anthropic/claude-sonnet-4-6', 'nope'],
  provider: ['offline', 'nope', 'anthropic'],
  thinking: ['high'],
  coding: [CWD],
  new: [CWD],
  sessions: ['ses_other'],
  name: ['hello', '\x01'],
  queue: ['later'],
  steer: ['go'],
  branch: ['feat/x'],
  pr: ['main'],
  rewind: ['7'],
  undo: ['reconcile', 'bogus'],
  plan: ['the thing'],
  review: ['security'],
  skills: ['clear', 'review AGENTS.md skills/x', 'review', 'bogus'],
  classifier: ['on', 'small'],
  hooks: ['trust', 'revoke', 'bogus'],
  jobs: ['stop job_1', 'bogus'],
  export: [CWD + '/out.md'],
};

test.each(['without a session', 'with a session'])(
  'every slash command, %s, does what it did',
  async (when) => {
    const session = when === 'with a session';
    const result: Record<string, Record<string, string>> = {};
    for (const command of SLASH_COMMANDS)
      for (const args of ['', ...(ARGS[command.name] ?? [])])
        result['/' + command.name + (args ? ' ' + args : '')] = await sweep(session, (internal) =>
          internal.runSlashCommand(command.name, args),
        );
    expect(result).toMatchSnapshot('slash commands');
  },
  60_000,
);

test.each(['without a session', 'with a session'])(
  'every Ctrl+K action, %s, does what it did',
  async (when) => {
    // The external editor would start a real process; its key is covered by the composer tests.
    const result = await sweep(
      when === 'with a session',
      (internal) => internal.globalActions().palette(),
      ['editor'],
    );
    expect(result).toMatchSnapshot('actions');
  },
  60_000,
);

test('an unknown command name is refused before any handler runs', async () => {
  const { internal } = fake(true);
  await expect(internal.runSlashCommand('nope')).rejects.toThrow('Unknown command. Use /help.');
});
