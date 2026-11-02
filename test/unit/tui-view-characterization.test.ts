import { expect, test } from 'vitest';
import { DocumentView, type ViewModel, type ViewTab } from '../../src/tui/view.js';
import { OperatorClient } from '../../src/tui/client.js';
import { SalaamTheme } from '../../src/tui/theme.js';

// Phase 6 characterization: every tab of the session document, rendered with its colours, for a
// session that carries something in every section. The refactor that splits view.ts by section
// must render these exactly as before.
const TABS: ViewTab[] = ['conversation', 'changes', 'commands', 'context'];
const WIDTH = 96;

const session = (capabilities: string[]) =>
  JSON.parse(
    JSON.stringify({
      id: 'ses_view',
      cwd: '/tmp/view-proof',
      state: 'ready',
      epoch: 3,
      revision: 9,
      capabilities,
      history_truncated: true,
      submissions: [{ id: 'sub_q', text: 'queued @a.ts', state: 'accepted' }],
      attempts: [{ id: 'att_i', state: 'interrupted' }],
      messages: [
        { entry_id: 'e1', role: 'user', text: 'fix **it**' },
        {
          entry_id: 'e2',
          role: 'assistant',
          text: '# Done\n\n- one\n- two\n\n```ts\nconst a = 1;\n```',
          truncated: true,
          tool_calls: ['tc1'],
        },
      ],
      approvals: [{ id: 'apr_1', state: 'pending', operation_id: 'op_1', revision: 1 }],
      operations: [
        {
          id: 'op_1',
          kind: 'workspace',
          target: 'Local command: npm test',
          value: 'npm test',
          state: 'succeeded',
          receipt: 'exit 0',
          error: 'warning',
        },
      ],
      inbox: [{ id: 'in_1', kind: 'result', revision: 2, detail: 'A child finished' }],
      recurring_occurrence: {
        id: 'occ_1',
        job_id: 'rj_1',
        occurrence_key: 'k1',
        schedule_revision: 4,
      },
      job: {
        id: 'job_1',
        state: 'idle',
        name: 'nightly',
        binding_digest: 'b'.repeat(64),
        occurrence: { id: 'jo_1', occurrence_key: 'key' },
        reason: 'waiting',
      },
      team: {
        assignments: [
          {
            id: 'asg_1',
            profile_id: 'reviewer',
            generation: 2,
            step_state: 'running',
            stale: true,
            runtime: { id: 'rt_1', provider_route: { provider: 'anthropic', model: 'm' } },
            execution: {
              state: 'running',
              stopped: false,
              stop_scope: 'remote-terminal-receipt',
              peer: { peer_id: 'p1', task_id: null, cancel_state: null, remote_state: null },
            },
          },
        ],
        messages: [
          {
            id: 'msg_1',
            sender: 'operator',
            recipient: 'asg_1',
            delivered_at: 1,
            acknowledged_at: null,
          },
        ],
      },
      work_task: {
        id: 'task_1',
        revision: 3,
        plan_revision: 2,
        state: 'running',
        objective: 'Fix the bug',
        reason: 'one step left',
        constraints: ['no new deps'],
        runtime: {
          requests_spent: 2,
          reserved_requests: 1,
          token_units: 10,
          reserved_tokens: 5,
          auto_enabled: true,
          remaining_steps: 1,
          auto_error: 'paused once',
        },
        verification: {
          checks: [
            {
              id: 'chk_1',
              check_key: 'tests',
              state: 'passed',
              fresh: true,
              workspace_revision: 2,
            },
          ],
          completion: { state: 'verified', fresh: false },
        },
        steps: [
          {
            id: 'step_1',
            key: 'work',
            title: 'Implement',
            instruction: 'Do it',
            depends_on: [],
            state: 'awaiting_review',
            attempt_id: 'att_s',
            review: 'looked fine',
          },
        ],
        acceptance: [],
        deliverables: [],
        limits: { requests: 9, token_units: 100, output_token_bound: null },
      },
      agents: [
        {
          profile_id: 'reviewer',
          revision: 1,
          state: 'admitted',
          route: { provider: 'anthropic', model: 'm' },
          tools: ['read'],
        },
      ],
      children: [
        {
          id: 'child_1',
          state: 'done',
          result_id: 'res_1',
          acknowledged: true,
          worker: {
            generation: 1,
            dispatch_state: 'settled',
            binding: {
              profile: { id: 'reviewer' },
              runtime: 'native',
              bounds: { scope: 'model-requests', requests: 3 },
              isolation: { workspace_id: 'ws_draft', execution: { evidence: 'container' } },
            },
          },
        },
      ],
    }),
  );

function view(capabilities: string[], tab: ViewTab, theme: 'night' | 'paper'): ViewModel {
  const client = new OperatorClient('/tmp/salaam-view-characterization');
  client.snapshot = session(capabilities);
  client.connection = 'connected';
  client.activity = JSON.parse(
    JSON.stringify([
      {
        seq: 1,
        kind: 'tool.started',
        payload: {
          attempt_id: 'att_s',
          tool_call_id: 'tc1',
          tool: 'read',
          input: '{"path":"a.ts"}',
        },
      },
      {
        seq: 2,
        kind: 'tool.finished',
        payload: { attempt_id: 'att_s', tool_call_id: 'tc1', tool: 'read', output: 'text' },
      },
      {
        seq: 3,
        kind: 'tool.started',
        payload: {
          attempt_id: 'att_s',
          tool_call_id: 'tc2',
          tool: 'bash',
          input: '{"command":"ls"}',
        },
      },
    ]),
  );
  client.preview = { attempt_id: 'att_s', text: 'writing *now*', truncated: true };
  client.facts = [{ id: 'f1', kind: 'decision', text: 'Use **one** store' }];
  client.usage = JSON.parse(
    JSON.stringify({
      observations: 2,
      unknown_observations: 1,
      known_input: 100,
      known_output: 20,
      known_cache_read: 5,
      known_cost: 0.01,
      estimated_cost: 0.02,
    }),
  );
  client.commands = JSON.parse(
    JSON.stringify([
      {
        id: 'run_1',
        command: 'npm test',
        state: 'failed',
        workspace_revision: 2,
        exit_code: 1,
        error: 'boom',
      },
      { id: 'run_2', command: 'ls', state: 'running', workspace_revision: 2, exit_code: null },
    ]),
  );
  if (!capabilities.length)
    client.workspace = JSON.parse(
      JSON.stringify({
        id: 'ws_1',
        source: '/src/repo',
        root: '/tmp/ws',
        revision: 2,
        digest: 'd'.repeat(64),
        observed_digest: 'e'.repeat(64),
      }),
    );
  return {
    client,
    theme: new SalaamTheme(theme),
    tab,
    rows: () => 30,
    bodyRows: () => 20,
    diffOffset: 0,
    busy: false,
    log: { id: 'run_1', text: 'line one\nline two', offset: 17, complete: false },
    diff: JSON.parse(
      JSON.stringify({
        revision: 2,
        digest: 'd',
        next_offset: null,
        changes: [{ path: 'a.ts', before: 'one\n', after: 'two\n' }],
      }),
    ),
    review: JSON.parse(
      JSON.stringify({
        data: {
          background_running: 1,
          files: [
            { path: 'a.ts', status: 'modified', added: 1, removed: 1 },
            { path: 'b.ts', status: 'added', added: 3, removed: 0 },
          ],
        },
        file: 0,
        hunks: [{ text: '@@ -1 +1 @@\n-one\n+two\n' }],
        hunk: 0,
      }),
    ),
    mode: { mode: 'review', sandbox: 'seatbelt' },
  };
}

test.each([
  ['a local coding session', ['local-workspace-read', 'local-coding-reviewed']],
  ['a coding workspace', []],
])('every tab of %s renders as it did', (_name, capabilities) => {
  const rendered: Record<string, string[]> = {};
  for (const theme of ['night', 'paper'] as const)
    for (const tab of TABS) {
      const model = view(capabilities, tab, theme);
      rendered[`${theme} ${tab}`] = new DocumentView(model).render(WIDTH);
      model.transcript = true;
      if (tab === 'conversation')
        rendered[`${theme} ${tab} transcript`] = new DocumentView(model).render(WIDTH);
    }
  expect(rendered).toMatchSnapshot('tabs');
});

test('a session with no messages shows the welcome, and no session shows it too', () => {
  const model = view(['local-workspace-read'], 'conversation', 'night');
  const empty = model.client.snapshot;
  if (!empty) throw new Error('no snapshot');
  model.client.snapshot = { ...empty, messages: [], submissions: [], work_task: undefined };
  const welcome = new DocumentView(model).render(WIDTH);
  model.client.snapshot = undefined;
  expect({ welcome, none: new DocumentView(model).render(WIDTH) }).toMatchSnapshot('welcome');
});
