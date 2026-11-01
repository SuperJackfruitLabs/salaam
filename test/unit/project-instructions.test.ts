import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { TaskContext } from '../../src/runtime/task-context.js';
import { providerRoute } from '../../src/providers/config.js';
import {
  discoverInstructions,
  INSTRUCTION_FILE_BYTES,
  ProjectInstructions,
} from '../../src/runtime/project-instructions.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tree() {
  const root = realpathSync(mkdtempSync('/tmp/sal-instr-'));
  roots.push(root);
  mkdirSync(join(root, 'repo/.git'), { recursive: true });
  mkdirSync(join(root, 'repo/pkg/app'), { recursive: true });
  mkdirSync(join(root, 'config/salaam'), { recursive: true });
  return root;
}

test('reads the user file, then AGENTS.md from the repository root down to the session folder', () => {
  const root = tree();
  writeFileSync(join(root, 'config/salaam/AGENTS.md'), 'USER rule\n');
  writeFileSync(join(root, 'repo/AGENTS.md'), 'ROOT rule\n');
  writeFileSync(join(root, 'repo/pkg/AGENTS.md'), 'PKG rule\n');
  const found = discoverInstructions(
    join(root, 'repo/pkg/app'),
    join(root, 'config/salaam/AGENTS.md'),
  );
  expect(found.files.map((f) => [f.scope, f.path, f.text])).toEqual([
    ['user', join(root, 'config/salaam/AGENTS.md'), 'USER rule\n'],
    ['project', '../../AGENTS.md', 'ROOT rule\n'],
    ['project', '../AGENTS.md', 'PKG rule\n'],
  ]);
  expect(found.skipped).toEqual([]);
});

test('CLAUDE.md is read only where a directory has no AGENTS.md', () => {
  const root = tree();
  writeFileSync(join(root, 'repo/AGENTS.md'), 'A\n');
  writeFileSync(join(root, 'repo/CLAUDE.md'), 'C root\n');
  writeFileSync(join(root, 'repo/pkg/CLAUDE.md'), 'C pkg\n');
  const found = discoverInstructions(join(root, 'repo/pkg'), null);
  expect(found.files.map((f) => f.path)).toEqual(['../AGENTS.md', 'CLAUDE.md']);
});

test('outside a repository only the session folder is read', () => {
  const root = tree();
  mkdirSync(join(root, 'plain/sub'), { recursive: true });
  writeFileSync(join(root, 'plain/AGENTS.md'), 'parent\n');
  writeFileSync(join(root, 'plain/sub/AGENTS.md'), 'here\n');
  expect(discoverInstructions(join(root, 'plain/sub'), null).files.map((f) => f.text)).toEqual([
    'here\n',
  ]);
});

test('symbolic links, oversized and non-UTF-8 files are skipped with a reason', () => {
  const root = tree();
  writeFileSync(join(root, 'secret.md'), 'outside\n');
  symlinkSync(join(root, 'secret.md'), join(root, 'repo/AGENTS.md'));
  writeFileSync(join(root, 'repo/pkg/AGENTS.md'), 'x'.repeat(INSTRUCTION_FILE_BYTES + 1));
  writeFileSync(join(root, 'repo/pkg/app/AGENTS.md'), Buffer.from([0xff, 0xfe, 0x00]));
  const found = discoverInstructions(join(root, 'repo/pkg/app'), null);
  expect(found.files).toEqual([]);
  expect(found.skipped.map((s) => s.reason)).toEqual([
    'symbolic links are not loaded',
    'larger than 32 KiB',
    'not UTF-8 text',
  ]);
});

function session(local: boolean) {
  const root = tree();
  const store = new Store(join(root, 'journal.sqlite'));
  const artifacts = new Artifacts(join(root, 'artifacts'), store);
  const cwd = join(root, 'repo');
  const id = local
    ? store.create(cwd, 'create', false, {
        workspace: true,
        coding: true,
        requestedRoute: providerRoute(),
        route: providerRoute(),
        outputCap: true,
      }).id
    : store.create(cwd, 'create').id;
  const instructions = new ProjectInstructions(store, artifacts, null);
  const tasks = new TaskContext(store, artifacts);
  tasks.instructions = instructions;
  return { root, cwd, store, id, instructions, tasks };
}
const loaded = (store: Store, id: string) =>
  store.events(id, 0).filter((e) => e.kind === 'instructions.loaded');

test('an interactive session records each change once and puts the guidance in its task frame', () => {
  const s = session(true);
  writeFileSync(join(s.cwd, 'AGENTS.md'), 'Use the GREEN protocol.\n');
  expect(s.instructions.refresh(s.id)!.files.map((f) => f.path)).toEqual(['AGENTS.md']);
  expect(s.instructions.refresh(s.id)!.revision).toBe(1);
  expect(loaded(s.store, s.id).map((e) => (e.payload as { reason: string }).reason)).toEqual([
    'initial',
  ]);
  expect(s.tasks.frame(s.id, 'x'.repeat(32))).toContain('SALAAM_PROJECT_INSTRUCTIONS_V1');
  expect(s.tasks.frame(s.id, 'x'.repeat(32))).toContain('GREEN');
  writeFileSync(join(s.cwd, 'AGENTS.md'), 'Use the BLUE protocol.\n');
  expect(s.instructions.refresh(s.id)!.revision).toBe(2);
  expect(s.tasks.frame(s.id, 'x'.repeat(32))).toContain('BLUE');
  expect(s.tasks.frame(s.id, 'x'.repeat(32))).not.toContain('GREEN');
  rmSync(join(s.cwd, 'AGENTS.md'));
  s.instructions.refresh(s.id);
  expect(loaded(s.store, s.id).map((e) => (e.payload as { reason: string }).reason)).toEqual([
    'initial',
    'changed',
    'removed',
  ]);
  expect(s.tasks.frame(s.id, 'x'.repeat(32))).not.toContain('SALAAM_PROJECT_INSTRUCTIONS_V1');
});

test('a session with no instruction files records nothing', () => {
  const s = session(true);
  expect(s.instructions.refresh(s.id)).toBeNull();
  expect(loaded(s.store, s.id)).toEqual([]);
});

test('strict work never loads project instructions automatically', () => {
  const s = session(false);
  writeFileSync(join(s.cwd, 'AGENTS.md'), 'Use the GREEN protocol.\n');
  expect(s.instructions.refresh(s.id)).toBeNull();
  expect(loaded(s.store, s.id)).toEqual([]);
  expect(s.tasks.frame(s.id, 'x'.repeat(32))).not.toContain('GREEN');
});
