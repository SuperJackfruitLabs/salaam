import { expect, test } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { Workspaces, filePath, readTree } from '../../src/coding/workspaces.js';
import { digest } from '../../src/core/protocol.js';

function fixture() {
  const dir = mkdtempSync('/tmp/sal-workspace-'),
    source = join(dir, 'source'),
    root = join(dir, 'owned');
  mkdirSync(source);
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(source, 'app.js'), 'export const value = 1;\n');
  mkdirSync(join(source, '.git'));
  writeFileSync(join(source, '.git/config'), 'host-metadata');
  writeFileSync(join(source, '.env'), 'dummy-credential');
  const store = new Store(join(dir, 'journal.sqlite')),
    artifacts = new Artifacts(join(dir, 'artifacts'), store);
  const session = store.create(source, 'create'),
    workspaces = new Workspaces(store, artifacts, root);
  const w = workspaces.import(session.id, source);
  return {
    dir,
    source,
    store,
    artifacts,
    workspaces,
    w,
    session,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('owned import excludes metadata/credentials and file tools are bounded with line/hash references', () => {
  const f = fixture();
  try {
    expect(f.workspaces.read(f.session.id, { action: 'list' })).toMatchObject({
      revision: 0,
      files: [{ path: 'app.js' }],
    });
    expect(f.workspaces.read(f.session.id, { action: 'read', path: 'app.js' })).toMatchObject({
      lines: [
        { line: 1, text: 'export const value = 1;' },
        { line: 2, text: '' },
      ],
    });
    expect(f.workspaces.read(f.session.id, { action: 'search', query: 'value' })).toMatchObject({
      matches: [{ path: 'app.js', line: 1 }],
    });
    expect(f.workspaces.import(f.session.id, f.source).id).toBe(f.w.id);
    expect(f.workspaces.read(f.session.id, { action: 'list' })).not.toHaveProperty('.git');
  } finally {
    f.close();
  }
});
test('patches compare revision/hash, replay saved results before revision checks and leave the source untouched', () => {
  const f = fixture();
  try {
    const before = readTree(f.w.root);
    const args = {
      path: 'app.js',
      expected_revision: 0,
      expected_hash: digest(before['app.js']),
      content: 'export const value = 2;\n',
    };
    const receipt = f.workspaces.patch(f.session.id, 'patch-1', args);
    expect(receipt.state).toBe('applied');
    expect(f.workspaces.patch(f.session.id, 'patch-1', args)).toEqual(receipt);
    expect(f.workspaces.get(f.session.id).revision).toBe(1);
    expect(() =>
      f.workspaces.patch(f.session.id, 'patch-1', { ...args, content: 'changed' }),
    ).toThrow('different arguments');
    expect(() => f.workspaces.patch(f.session.id, 'patch-2', args)).toThrow('revision changed');
    expect(readFileSync(join(f.source, 'app.js'), 'utf8')).toContain('1');
    expect(f.workspaces.diff(f.session.id)).toMatchObject({ changes: [{ path: 'app.js' }] });
  } finally {
    f.close();
  }
});
test('traversal, symlinks, hardlinks and metadata never become host file authority', () => {
  for (const path of [
    '/etc/passwd',
    '../key',
    'a/../../key',
    'a\\key',
    '.git/config',
    'a/.salaam/control',
    './app.js',
  ])
    expect(() => filePath(path)).toThrow();
  const f = fixture();
  try {
    const secret = join(f.dir, 'secret');
    writeFileSync(secret, 'dummy');
    symlinkSync(secret, join(f.w.root, 'escape'));
    expect(() => f.workspaces.read(f.session.id, { action: 'read', path: 'escape' })).toThrow(
      'Symlinks',
    );
    rmSync(join(f.w.root, 'escape'));
    linkSync(secret, join(f.w.root, 'escape'));
    expect(() => f.workspaces.read(f.session.id, { action: 'read', path: 'escape' })).toThrow(
      'one link',
    );
    expect(readFileSync(secret, 'utf8')).toBe('dummy');
  } finally {
    f.close();
  }
});
test('out-of-band human edits deny overwrites until an exact reviewed refresh; command lock fences file mutations', () => {
  const f = fixture();
  try {
    const hash = digest(readTree(f.w.root)['app.js']);
    writeFileSync(join(f.w.root, 'app.js'), 'human edit\n');
    expect(() =>
      f.workspaces.patch(f.session.id, 'patch', {
        path: 'app.js',
        expected_revision: 0,
        expected_hash: hash,
        content: 'model edit',
      }),
    ).toThrow('Out-of-band');
    const reviewed = digest(readTree(f.w.root));
    expect(() => f.workspaces.refresh(f.session.id, 'refresh-wrong', 0, 'wrong', () => {})).toThrow(
      'changed',
    );
    const accepted = f.workspaces.refresh(f.session.id, 'refresh', 0, reviewed, () => {});
    expect(accepted.revision).toBe(1);
    expect(
      f.workspaces.refresh(f.session.id, 'refresh', 0, reviewed, () => {
        throw Error('expired');
      }),
    ).toEqual(accepted);
    f.workspaces.lock(f.session.id, 'command');
    expect(() =>
      f.workspaces.patch(f.session.id, 'blocked', {
        path: 'new.js',
        expected_revision: 1,
        expected_hash: null,
        content: 'new',
      }),
    ).toThrow('owns');
    f.workspaces.unlock(f.session.id, 'command');
    expect(readFileSync(join(f.w.root, 'app.js'), 'utf8')).toBe('human edit\n');
  } finally {
    f.close();
  }
});
test('recovery recognizes bytes changed before receipt without replay; partial changes remain a conflict', () => {
  const f = fixture();
  try {
    const before = readTree(f.w.root),
      after = structuredClone(before);
    after['app.js'] = { content: Buffer.from('after\n').toString('base64'), executable: false };
    const saved = f.workspaces.reconcile.bind(f.workspaces);
    f.workspaces.reconcile = () => {
      throw Error('crash after rename');
    };
    expect(() =>
      f.workspaces.replace(f.session.id, 'crash', digest('input'), 0, before, after),
    ).toThrow('crash');
    f.workspaces.reconcile = saved;
    const replacement = new Workspaces(f.store, f.artifacts, join(f.dir, 'owned'));
    replacement.recover();
    expect(replacement.get(f.session.id)).toMatchObject({
      revision: 1,
      digest: digest(after),
      state: 'ready',
    });
    replacement.recover();
    expect(replacement.get(f.session.id).revision).toBe(1);
    const next = structuredClone(after);
    next['app.js'] = { content: Buffer.from('next\n').toString('base64'), executable: false };
    replacement.reconcile = () => {
      throw Error('crash');
    };
    expect(() =>
      replacement.replace(f.session.id, 'partial', digest('next'), 1, after, next),
    ).toThrow('crash');
    const oldRoot = replacement.get(f.session.id).root;
    writeFileSync(join(oldRoot, 'app.js'), 'human intervened');
    const last = new Workspaces(f.store, f.artifacts, join(f.dir, 'owned'));
    last.recover();
    expect(last.get(f.session.id).state).toBe('conflict');
    expect(readFileSync(join(oldRoot, 'app.js'), 'utf8')).toBe('human intervened');
  } finally {
    f.close();
  }
});
test('recording failure denies patch before file changes', () => {
  const f = fixture();
  try {
    const before = readTree(f.w.root);
    f.store.db.exec('PRAGMA query_only=ON');
    expect(() =>
      f.workspaces.patch(f.session.id, 'disk-full', {
        path: 'app.js',
        expected_revision: 0,
        expected_hash: digest(before['app.js']),
        content: 'new',
      }),
    ).toThrow();
    expect(readTree(f.w.root)).toEqual(before);
  } finally {
    f.close();
  }
});

test('publication uses a new root and preserves an editor writing the previous revision', () => {
  const f = fixture();
  try {
    const old = f.w.root,
      before = readTree(old),
      receipt = f.workspaces.patch(f.session.id, 'new-revision', {
        path: 'app.js',
        expected_revision: 0,
        expected_hash: digest(before['app.js']),
        content: 'model revision\n',
      });
    expect(receipt.state).toBe('applied');
    const current = f.workspaces.get(f.session.id);
    expect(current.id).toBe(f.w.id);
    expect(current.root).not.toBe(old);
    writeFileSync(join(old, 'app.js'), 'concurrent editor bytes');
    expect(readFileSync(join(current.root, 'app.js'), 'utf8')).toBe('model revision\n');
    expect(readFileSync(join(old, 'app.js'), 'utf8')).toBe('concurrent editor bytes');
  } finally {
    f.close();
  }
});
test('empty files and prototype-named files remain ordinary guarded paths', () => {
  const f = fixture();
  try {
    expect(
      f.workspaces.patch(f.session.id, 'empty', {
        path: '__proto__',
        expected_revision: 0,
        expected_hash: null,
        content: '',
      }).state,
    ).toBe('applied');
    expect(f.workspaces.read(f.session.id, { action: 'read', path: '__proto__' })).toMatchObject({
      lines: [{ line: 1, text: '' }],
    });
    expect(() => filePath('a\x1b]52;unsafe')).toThrow();
  } finally {
    f.close();
  }
});
