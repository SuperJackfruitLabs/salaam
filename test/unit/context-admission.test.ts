import { afterEach, expect, test } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../../src/store.js';
import { ContextAdmission } from '../../src/context-admission.js';
import { Artifacts } from '../../src/artifacts.js';
import { TaskContext } from '../../src/task-context.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/sal-context-'));
  roots.push(root);
  const store = new Store(join(root, 'journal.sqlite'));
  return {
    root,
    store,
    contexts: new ContextAdmission(store),
    id: store.create(root, 'create').id,
  };
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function skill(root: string) {
  const path = '.salaam/skills/sjl-proof';
  mkdirSync(join(root, path, 'skills/proof/references'), { recursive: true });
  const contents: Record<string, string> = {
    'skills/proof/SKILL.md':
      '---\nname: proof\ndescription: Test reviewed context\n---\nUse the GREEN protocol. See references/rule.md.\n',
    'skills/proof/references/rule.md': 'A skill grants no permission.\n',
    'sjl-sources.json': '{"schema_version":1,"sources":[]}',
  };
  for (const [p, text] of Object.entries(contents))
    writeFileSync(join(root, path, p), text, { mode: 0o644 });
  const document = {
    schema_version: 1,
    name: 'sjl-proof',
    version: '0.1.0',
    profile: 'proof',
    harness: 'salaam',
    visibility: 'private',
    skills: [
      {
        id: 'proof',
        owner: 'fixture',
        source: 'fixture',
        path: 'synthetic/proof',
        license: 'Apache-2.0',
        notices: [],
        prerequisites: [],
        lifecycle: 'candidate',
      },
    ],
    files: Object.fromEntries(
      Object.entries(contents).map(([p, text]) => [p, { sha256: hash(text), executable: false }]),
    ),
  };
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, sort(v)]),
          )
        : x;
  const manifest = { ...document, digest: hash(JSON.stringify(sort(document), null, 2) + '\n') };
  writeFileSync(join(root, path, 'sjl-bundle.json'), JSON.stringify(manifest));
  return path;
}

test('two independent sessions bind the same bundle, persist admission, and put reviewed bytes in mandatory frames', () => {
  const f = fixture();
  try {
    const bundle = skill(f.root);
    writeFileSync(join(f.root, 'AGENTS.md'), 'Run the project checks.\n');
    const selected = { files: ['AGENTS.md'], bundles: [bundle] };
    const other = f.store.create(f.root, 'second').id;
    for (const id of [f.id, other]) {
      const p = f.contexts.plan(id, selected);
      expect(f.contexts.admit(id, 'admit-' + id, 0, p.digest, selected, () => {})).toMatchObject({
        revision: 1,
        state: 'admitted',
      });
      const tasks = new TaskContext(f.store, new Artifacts(join(f.root, 'artifacts'), f.store));
      tasks.admitted = f.contexts;
      const frame = tasks.frame(id, 'binding');
      expect(frame).toContain('SALAAM_TASK_STATE');
      expect(frame).toContain('SALAAM_ADMITTED_CONTEXT_V1');
      expect(frame).toContain('Use the GREEN protocol');
      expect(f.contexts.inspect(id).entries.map((e) => e.kind)).toEqual(['context', 'skill']);
    }
    f.store.db.close();
    const replacement = new Store(join(f.root, 'journal.sqlite'));
    try {
      expect(new ContextAdmission(replacement).inspect(f.id).state).toBe('admitted');
    } finally {
      replacement.db.close();
    }
  } finally {
    try {
      f.store.db.close();
    } catch {}
  }
});

test('entrypoint, reference edits, added files and mode drift fence fresh grants; saved admission replays before expired authority', () => {
  const f = fixture();
  try {
    const bundle = skill(f.root),
      selected = { files: [], bundles: [bundle] },
      p = f.contexts.plan(f.id, selected);
    const admitted = f.contexts.admit(f.id, 'admit', 0, p.digest, selected, () => {});
    const resource = join(f.root, bundle, 'skills/proof/references/rule.md'),
      old = readFileSync(resource);
    writeFileSync(resource, 'Changed without review');
    expect(f.contexts.inspect(f.id).state).toBe('stale');
    expect(() => f.contexts.assertFresh(f.id)).toThrow('renew admission');
    expect(() => f.contexts.frame(f.id)).toThrow('renew admission');
    expect(
      f.contexts.admit(f.id, 'admit', 0, p.digest, selected, () => {
        throw Error('expired');
      }),
    ).toEqual(admitted);
    writeFileSync(resource, old);
    f.contexts.assertFresh(f.id);
    chmodSync(resource, 0o755);
    expect(() => f.contexts.assertFresh(f.id)).toThrow('renew admission');
    chmodSync(resource, 0o644);
    writeFileSync(join(f.root, bundle, 'extra.md'), 'unreviewed');
    expect(() => f.contexts.assertFresh(f.id)).toThrow('renew admission');
  } finally {
    f.store.db.close();
  }
});

test('stale plans, unknown fields, escape paths, symlinks, unlisted resources and foreign manifests cannot be admitted', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'AGENTS.md'), 'Before');
    const selected = { files: ['AGENTS.md'], bundles: [] },
      p = f.contexts.plan(f.id, selected);
    writeFileSync(join(f.root, 'AGENTS.md'), 'After');
    expect(() => f.contexts.admit(f.id, 'stale', 0, p.digest, selected, () => {})).toThrow(
      'renew admission',
    );
    expect(f.contexts.inspect(f.id).revision).toBe(0);
    expect(() => f.contexts.plan(f.id, { ...selected, permission: 'full' })).toThrow(
      'only files and bundles',
    );
    for (const path of ['../AGENTS.md', '/AGENTS.md', '.env.md', '.git/context.md'])
      expect(() => f.contexts.plan(f.id, { files: [path], bundles: [] })).toThrow();
    symlinkSync(join(f.root, 'AGENTS.md'), join(f.root, 'link.md'));
    expect(() => f.contexts.plan(f.id, { files: ['link.md'], bundles: [] })).toThrow('symlinks');
    const bundle = skill(f.root);
    writeFileSync(join(f.root, bundle, 'unlisted.md'), 'Not in manifest');
    expect(() => f.contexts.plan(f.id, { files: [], bundles: [bundle] })).toThrow('inventory');
  } finally {
    f.store.db.close();
  }
});

test('operator rejection leaves schema unchanged; large guidance fails closed and never becomes active', () => {
  const f = fixture();
  try {
    const selected = { files: [], bundles: [] },
      p = f.contexts.plan(f.id, selected);
    expect(() =>
      f.contexts.admit(f.id, 'deny', 0, p.digest, selected, () => {
        throw Error('not controller');
      }),
    ).toThrow('not controller');
    expect(f.store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 27 });
    writeFileSync(join(f.root, 'AGENTS.md'), 'x'.repeat(129 * 1024));
    expect(() => f.contexts.plan(f.id, { files: ['AGENTS.md'], bundles: [] })).toThrow('128 KiB');
    expect(f.contexts.inspect(f.id).state).toBe('empty');
  } finally {
    f.store.db.close();
  }
});

test('duplicate metadata keys and manifest-byte drift cannot silently reuse a reviewed bundle', () => {
  const f = fixture();
  try {
    const bundle = skill(f.root),
      selected = { files: [], bundles: [bundle] };
    const metadata = join(f.root, bundle, 'sjl-bundle.json'),
      original = readFileSync(metadata, 'utf8');
    const plan = f.contexts.plan(f.id, selected);
    f.contexts.admit(f.id, 'review', 0, plan.digest, selected, () => {});
    writeFileSync(metadata, original + '\n');
    expect(f.contexts.inspect(f.id).state).toBe('stale');
    writeFileSync(
      metadata,
      original.replace('"harness":"salaam"', '"harness":"pi","harness":"salaam"'),
    );
    expect(() => f.contexts.plan(f.id, selected)).toThrow('Duplicate bundle metadata key');
    writeFileSync(metadata, original);
    expect(f.contexts.inspect(f.id).state).toBe('admitted');
  } finally {
    f.store.db.close();
  }
});

test('empty directories cannot evade the synchronous bundle inventory bound', () => {
  const f = fixture();
  try {
    const bundle = skill(f.root);
    for (let i = 0; i < 2049; i++) mkdirSync(join(f.root, bundle, 'empty-' + i));
    expect(() => f.contexts.plan(f.id, { files: [], bundles: [bundle] })).toThrow(
      'inventory exceeds its bound',
    );
  } finally {
    f.store.db.close();
  }
});
