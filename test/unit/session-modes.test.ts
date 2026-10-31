import { visibleWidth } from '@earendil-works/pi-tui';
import { FormModal } from '../../src/tui-modals.js';
import { SalaamTheme } from '../../src/tui-theme.js';
import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding } from '../../src/local-coding.js';
import {
  configurePermissions,
  permissionPolicy,
  permissionDigest,
  validatePermissions,
  nextMode,
  autoApprovesEdits,
  type PermissionMode,
} from '../../src/autonomy.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { localHash } from '../../src/local-edits.js';
import { ApprovalRules } from '../../src/approval-rules.js';
import { shellPassthrough } from '../../src/shell-passthrough.js';

// Phase 2b (operator rulings 2026-10-31): one-key modes for interactive coding sessions — review,
// accept edits, auto — plus full access (no sandbox; dangerous commands ask) and YOLO (no approvals).
function setup(
  opts: {
    allowFullAccess?: boolean;
    allowYolo?: boolean;
    desk?: boolean;
    workspace?: boolean;
    text?: string;
  } = {},
) {
  const root = realpathSync(mkdtempSync('/tmp/sal-modes-')),
    store = new Store(':memory:');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'before');
  const session =
    opts.workspace === false
      ? store.create(root, 'create', false)
      : store.create(root, 'create', false, {
          workspace: true,
          coding: true,
          route: OFFLINE_ROUTE,
        });
  const lease = store.control(session.id, 'lease', 'operator', 'acquire', 0),
    actor = { client_id: 'operator', token: lease.token };
  const submission = store.accept(
    session.id,
    'submit',
    store.session(session.id).revision,
    opts.text ?? 'go',
  );
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const active = (id: string, e: number, attempt: string) => {
    store.execution.assert(id);
    store.assertEpoch(id, e);
    if (store.cancelled(attempt) || store.attempt(attempt).state !== 'running')
      throw Error('inactive');
  };
  const managed = new ManagedWork(store, {
      assertActive: active,
      reply: () => {},
      failed: () => {},
    }),
    local = new LocalCoding(store, managed, active, undefined, {
      kind: 'bwrap',
      level: 'workspace-write',
      bwrap: { path: '/usr/bin/bwrap', version: 'bubblewrap 0.11.1' },
    });
  let n = 0;
  const configure = (mode: PermissionMode, access?: 'full' | 'yolo') => {
    const rev = permissionPolicy(store, session.id).revision;
    return configurePermissions(
      store,
      session.id,
      'policy-' + n++,
      rev,
      { mode, paths: [], ...(access ? { access } : {}) },
      actor,
      {
        allowFullAccess: opts.allowFullAccess ?? true,
        allowYolo: opts.allowYolo ?? true,
        deskSession: opts.desk ?? true,
      },
    );
  };
  const edit = (path = 'src/a.txt') =>
    local.prepare(session.id, epoch, submission.attempt_id, 'edit-' + n++, {
      action: 'edit',
      edits: [
        { path, sha256: path === 'src/a.txt' ? localHash('before') : null, content: 'after' },
      ],
    });
  const command = (text = 'echo hi') =>
    local.prepare(session.id, epoch, submission.attempt_id, 'cmd-' + n++, {
      action: 'command',
      command: text,
    });
  const ids = (): [number, string, string] => [epoch, submission.attempt_id, 'rv-' + n++];
  const args = (call: { id: string }) =>
    JSON.parse(
      String(store.db.prepare('SELECT args FROM local_calls WHERE id=?').get(call.id)!.args),
    );
  const state = (approval: { id: string }) =>
    String(store.db.prepare('SELECT state FROM approvals WHERE id=?').get(approval.id)!.state);
  return {
    root,
    store,
    session,
    actor,
    managed,
    local,
    configure,
    edit,
    command,
    state,
    args,
    ids,
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the new modes validate, take no paths, and full access is an explicit separate field', () => {
  for (const mode of ['accept-edits', 'auto'] as const)
    expect(validatePermissions({ mode, paths: [] })).toEqual({ mode, paths: [] });
  expect(() => validatePermissions({ mode: 'auto', paths: ['src/'] })).toThrow();
  expect(validatePermissions({ mode: 'review', paths: [], access: 'full' })).toEqual({
    mode: 'review',
    paths: [],
    access: 'full',
  });
  expect(() => validatePermissions({ mode: 'review', paths: [], access: 'root' })).toThrow();
});

test('a sandboxed policy keeps its digest: existing auto-approval bindings stay valid', async () => {
  const f = setup();
  try {
    const saved = f.configure('review');
    expect('access' in saved).toBe(false);
    expect(permissionDigest(permissionPolicy(f.store, f.session.id))).toBe(permissionDigest(saved));
  } finally {
    await f.close();
  }
});

test('plan mode is gone: it is refused, and a session saved in it reads as review', async () => {
  expect(() => validatePermissions({ mode: 'plan', paths: [] })).toThrow();
  const f = setup();
  try {
    f.store.transaction(() =>
      f.store.event(f.session.id, 'permissions.configured', {
        mode: 'plan',
        paths: [],
        revision: 1,
        root: f.root,
      }),
    );
    expect(permissionPolicy(f.store, f.session.id)).toMatchObject({ mode: 'review', revision: 1 });
    // A review-mode session asks for edits; nothing is read-only any more but inspect.
    expect(f.state(f.edit().approval)).toBe('pending');
  } finally {
    await f.close();
  }
});

test('accept-edits approves project edits by itself, but commands and private paths still ask', async () => {
  const f = setup();
  try {
    f.configure('accept-edits');
    expect(f.state(f.edit().approval)).toBe('decided');
    expect(f.state(f.command().approval)).toBe('pending');
    // Private and hidden paths are refused before a mode is consulted; the mode rule refuses them too.
    const policy = permissionPolicy(f.store, f.session.id);
    expect(autoApprovesEdits(policy, ['src/a.txt'])).toBe(true);
    for (const path of ['.git/config', 'node_modules/x.js', '../out.txt', '/etc/passwd', ''])
      expect(autoApprovesEdits(policy, [path])).toBe(false);
  } finally {
    await f.close();
  }
});

test('auto approves edits and sandboxed commands, and records the policy it used', async () => {
  const f = setup();
  try {
    const policy = f.configure('auto');
    expect(f.state(f.edit().approval)).toBe('decided');
    const cmd = f.command();
    expect(f.state(cmd.approval)).toBe('decided');
    const receipt = f.store.db
      .prepare(
        "SELECT payload FROM events WHERE kind='permission.auto-approved' AND json_extract(payload,'$.operation_id')=?",
      )
      .get(cmd.operation.id) as { payload: string };
    expect(JSON.parse(receipt.payload).policy_digest).toBe(permissionDigest(policy));
  } finally {
    await f.close();
  }
});

test('full access runs ordinary commands unsandboxed without asking; dangerous ones ask and say why', async () => {
  const f = setup();
  try {
    f.configure('review', 'full');
    const cmd = f.command('npm test');
    expect(f.args(cmd.call).sandbox.level).toBe('full-access');
    expect(String(cmd.operation.value)).toContain('you turned on full access for this session');
    expect(String(cmd.operation.value)).not.toContain('operator');
    expect(f.state(cmd.approval)).toBe('decided');
    const push = f.command('git push --force origin main');
    expect(f.state(push.approval)).toBe('pending');
    expect(String(push.operation.value)).toMatch(/Dangerous \(git-history\): git: rewrites/);
    // Ordinary project edits need no approval either; private paths still ask.
    expect(f.state(f.edit().approval)).toBe('decided');
    f.configure('auto');
    expect(f.args(f.command().call).sandbox.level).toBe('workspace-write');
  } finally {
    await f.close();
  }
});

test('YOLO approves everything, even dangerous commands, and records what full access would have asked', async () => {
  const f = setup();
  try {
    f.configure('review', 'yolo');
    const push = f.command('git push --force origin main');
    expect(f.args(push.call).sandbox.level).toBe('full-access');
    expect(f.state(push.approval)).toBe('decided');
    expect(f.state(f.command('npm test').approval)).toBe('decided');
    expect(f.state(f.edit().approval)).toBe('decided');
    const notes = f.store.db
      .prepare("SELECT payload FROM events WHERE kind='permission.yolo-approved' ORDER BY seq")
      .all()
      .map((r) => JSON.parse((r as { payload: string }).payload));
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatchObject({
      action: 'command',
      command: 'git push --force origin main',
      would_have_asked: { category: 'git-history' },
    });
    expect(notes[1].would_have_asked).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('YOLO is refused when the operator does not allow it, and outside desk sessions', async () => {
  const f = setup({ allowYolo: false });
  try {
    expect(() => f.configure('review', 'yolo')).toThrow('operator');
  } finally {
    await f.close();
  }
  const g = setup({ desk: false });
  try {
    expect(() => g.configure('review', 'yolo')).toThrow('desk sessions');
  } finally {
    await g.close();
  }
});

test('a repo rule cannot approve a dangerous command; the person’s own session rule can', async () => {
  const f = setup();
  const rules = new ApprovalRules(f.store, f.root + '/no-user-rules.json');
  f.local.rules = rules;
  try {
    rules.add(
      f.session.id,
      'repo',
      { effect: 'allow', tool: 'command', command: 'git push *' },
      'r1',
    );
    // A plain push publishes, so a repo rule cannot approve it either (operator ruling 2026-10-31).
    expect(f.state(f.command('git push origin feat').approval)).toBe('pending');
    expect(f.state(f.command('git push --force origin feat').approval)).toBe('pending');
    rules.add(
      f.session.id,
      'session',
      { effect: 'allow', tool: 'command', command: 'git push *' },
      'r2',
    );
    expect(f.state(f.command('git push --force origin feat').approval)).toBe('decided');
  } finally {
    await f.close();
  }
});

test('full access is refused when the operator does not allow it, and for non-local sessions', async () => {
  const f = setup({ allowFullAccess: false });
  try {
    expect(() => f.configure('review', 'full')).toThrow('operator');
  } finally {
    await f.close();
  }
  const g = setup({ workspace: false });
  try {
    expect(() => g.configure('review', 'full')).toThrow();
  } finally {
    await g.close();
  }
});

test('every mode change is a recorded session event', async () => {
  const f = setup();
  try {
    f.configure('auto');
    f.configure('accept-edits');
    const modes = f.store.db
      .prepare(
        "SELECT json_extract(payload,'$.mode') AS m FROM events WHERE kind='permissions.configured' ORDER BY seq",
      )
      .all()
      .map((r) => (r as { m: string }).m);
    expect(modes).toEqual(['auto', 'accept-edits']);
  } finally {
    await f.close();
  }
});

test('Shift+Tab cycles review, accept edits, auto and back to review', () => {
  expect(nextMode('review')).toBe('accept-edits');
  expect(nextMode('accept-edits')).toBe('auto');
  expect(nextMode('auto')).toBe('review');
  expect(nextMode('scoped-edit')).toBe('review');
  expect(nextMode('inspect')).toBe('review');
});

test('a long confirm hint (the YOLO warning) wraps inside its frame', () => {
  const hint =
    'NO approvals at all: every edit and command runs at once, without the OS sandbox, including force pushes, deletes and publishing. Each one is recorded. /yolo again turns it off.';
  const modal = new FormModal(
    'Turn on YOLO?',
    '',
    new SalaamTheme('night', false),
    false,
    () => {},
    () => {},
    () => {},
    { field: 'Type yolo', submit: 'continue', hint },
  );
  const lines = modal.render(60);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  expect(
    lines
      .join(' ')
      .replace(/\x1b\[[0-9;]*m|│/g, '')
      .replace(/\s+/g, ' '),
  ).toContain('/yolo again turns it off.');
});

test('pushing and opening a pull request ask in auto and full access, and say why', async () => {
  const f = setup();
  try {
    f.configure('auto');
    const push = f.command('git push -u origin feat');
    expect(f.state(push.approval)).toBe('pending');
    expect(String(push.operation.value)).toContain('Publishes: pushes commits to a remote');
    expect(f.state(f.command('git status').approval)).toBe('decided');
    f.configure('review', 'full');
    expect(f.state(f.command('git push origin feat').approval)).toBe('pending');
    expect(f.state(f.command('gh pr create --title t --body b').approval)).toBe('pending');
    expect(f.state(f.command('git commit -m x').approval)).toBe('decided');
  } finally {
    await f.close();
  }
});

test('YOLO approves a push and records that it would have asked', async () => {
  const f = setup();
  try {
    f.configure('review', 'yolo');
    expect(f.state(f.command('git push origin feat').approval)).toBe('decided');
    const note = f.store.db
      .prepare("SELECT payload FROM events WHERE kind='permission.yolo-approved'")
      .get() as { payload: string };
    expect(JSON.parse(note.payload).would_have_asked).toEqual({
      category: 'publish',
      reason: 'pushes commits to a remote',
    });
  } finally {
    await f.close();
  }
});

// Phase 4c (operator rulings 2026-10-31): an optional small-model reviewer can make a command ask
// that the rules let run; it can never let one run that would otherwise ask.
const reviewer = (
  escalate: boolean,
  verdict: 'ok' | 'ask' | 'unavailable' = escalate ? 'ask' : 'ok',
) => {
  const seen: string[] = [];
  return {
    seen,
    review: async (_s: string, command: string) => {
      seen.push(command);
      return {
        escalate,
        verdict,
        reason: escalate ? 'removes files outside the build' : '',
        model: 'small-1',
      };
    },
  };
};

test('the reviewer makes an opaque command ask in full access and in auto, with its reason recorded', async () => {
  const f = setup();
  try {
    f.local.classifier = reviewer(true);
    f.configure('review', 'full');
    const call = await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'node -e "x"',
    });
    expect(f.state(call.approval)).toBe('pending');
    expect(String(call.operation.value)).toMatch(
      /Dangerous \(classifier\): removes files outside the build \(reviewed by small-1\)/,
    );
    f.configure('auto');
    const auto = await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'node -e "y"',
    });
    expect(f.state(auto.approval)).toBe('pending');
    const notes = f.store.db
      .prepare("SELECT payload FROM events WHERE kind='permission.classifier' ORDER BY seq")
      .all()
      .map((r) => JSON.parse((r as { payload: string }).payload));
    expect(notes[0]).toMatchObject({ model: 'small-1', verdict: 'ask', escalated: true });
  } finally {
    await f.close();
  }
});

test('the person’s own session rule can approve a push', async () => {
  const f = setup();
  const rules = new ApprovalRules(f.store, f.root + '/no-user-rules.json');
  f.local.rules = rules;
  try {
    f.configure('review', 'full');
    rules.add(
      f.session.id,
      'session',
      { effect: 'allow', tool: 'command', command: 'git push *' },
      'r1',
    );
    expect(f.state(f.command('git push origin feat').approval)).toBe('decided');
  } finally {
    await f.close();
  }
});

test('an ok verdict changes nothing, and the reviewer is never asked for what the rules already ask', async () => {
  const f = setup();
  try {
    const r = reviewer(false);
    f.local.classifier = r;
    f.configure('review', 'full');
    const ok = await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'node -e "x"',
    });
    expect(f.state(ok.approval)).toBe('decided');
    const push = await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'git push --force origin main',
    });
    expect(f.state(push.approval)).toBe('pending');
    expect(r.seen).toEqual(['node -e "x"']);
  } finally {
    await f.close();
  }
});

test('in review mode the reviewer is not consulted; in YOLO it only records what it would have asked', async () => {
  const f = setup();
  try {
    const r = reviewer(true);
    f.local.classifier = r;
    f.configure('review');
    await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'node -e "x"',
    });
    expect(r.seen).toEqual([]);
    f.configure('review', 'yolo');
    const y = await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'node -e "z"',
    });
    expect(f.state(y.approval)).toBe('decided');
    const note = f.store.db
      .prepare("SELECT payload FROM events WHERE kind='permission.yolo-approved' ORDER BY seq DESC")
      .get() as { payload: string };
    expect(JSON.parse(note.payload).would_have_asked).toMatchObject({ category: 'classifier' });
  } finally {
    await f.close();
  }
});

test('without a reviewer nothing changes', async () => {
  const f = setup();
  try {
    f.configure('review', 'full');
    const call = await f.local.prepareReviewed(f.session.id, ...f.ids(), {
      action: 'command',
      command: 'node -e "x"',
    });
    expect(f.state(call.approval)).toBe('decided');
  } finally {
    await f.close();
  }
});

// Trial polish #12 (2026-10-31): `!command` runs exactly what was typed. The service binds the
// turn to that text, so a model that runs anything else is refused in every mode, YOLO included.
test('a !command turn may run only the typed command, once, in every mode', async () => {
  for (const [mode, access] of [
    ['review', undefined],
    ['auto', undefined],
    ['review', 'full'],
    ['review', 'yolo'],
  ] as const) {
    const f = setup({ text: shellPassthrough('!git status --short')! });
    try {
      f.configure(mode, access);
      expect(() => f.command('git status --short; rm -rf src')).toThrow(
        /only the command you typed/,
      );
      expect(() => f.command('git status')).toThrow(/only the command you typed/);
      expect(() => f.edit()).toThrow(/only the command you typed/);
      const ok = f.command('git status --short');
      expect(ok.operation).toBeTruthy();
      expect(() => f.command('git status --short')).toThrow(/already ran the command you typed/);
    } finally {
      await f.close();
    }
  }
});

test('an ordinary turn is not bound, even if it mentions !', async () => {
  const f = setup({ text: 'please run !ls for me' });
  try {
    f.configure('auto');
    expect(f.command('echo hi').operation).toBeTruthy();
  } finally {
    await f.close();
  }
});
