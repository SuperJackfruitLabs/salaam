import { expect, test } from 'vitest';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { TaskContext } from '../../src/runtime/task-context.js';
import { mkdtempSync, rmSync } from 'node:fs';

test('explicit corrections preserve provenance; capacity, conflicts and foreign evidence roll back atomically', () => {
  const dir = mkdtempSync('/tmp/sal-task-');
  const store = new Store(':memory:');
  const artifacts = new Artifacts(dir, store);
  const tasks = new TaskContext(store, artifacts);
  try {
    const id = store.create(dir, 'create').id;
    const other = store.create(dir, 'other').id;
    const original = tasks.update(id, 'old', 0, { kind: 'constraint', text: 'Use red' }, () => {});
    const corrected = tasks.update(
      id,
      'new',
      1,
      { kind: 'constraint', text: 'Use green', supersedes: original.facts[0]!.id },
      () => {},
    );
    expect(corrected.facts[0]).toMatchObject({
      text: 'Use red',
      source: 'operator:old',
      superseded_by: corrected.facts[1]!.id,
    });
    expect(
      tasks.update(
        id,
        'new',
        1,
        { kind: 'constraint', text: 'Use green', supersedes: original.facts[0]!.id },
        () => {
          throw new Error('lease expired');
        },
      ),
    ).toEqual(corrected);
    expect(() =>
      tasks.update(id, 'new', 1, { kind: 'constraint', text: 'Changed' }, () => {}),
    ).toThrow('different input');
    expect(() =>
      tasks.update(id, 'stale', 0, { kind: 'completed', text: 'Done' }, () => {}),
    ).toThrow('version changed');
    const artifact = artifacts.put(other, 'private evidence');
    expect(() =>
      tasks.update(
        id,
        'foreign',
        2,
        { kind: 'evidence', text: 'Evidence', artifact_id: artifact },
        () => {},
      ),
    ).toThrow('belong');
    expect(() => tasks.history(id, { artifact_id: artifact })).toThrow('not found');
    let version = 2;
    while (true) {
      try {
        tasks.update(
          id,
          'large-' + version,
          version,
          { kind: 'constraint', text: 'x'.repeat(4096) },
          () => {},
        );
        version++;
      } catch (e) {
        expect((e as Error).message).toContain('context budget');
        break;
      }
    }
    expect(tasks.state(id).version).toBe(version);
    expect(tasks.state(id).facts).toHaveLength(version);
    expect(store.events(id, 0).filter((e) => e.kind === 'task.updated')).toHaveLength(version);
    const local = artifacts.put(id, 'a'.repeat(9000));
    expect(tasks.history(id, { artifact_id: local })).toMatchObject({ next_offset: 8192 });
    expect(tasks.history(id, { artifact_id: local, offset: 8192 })).toMatchObject({
      text: 'a'.repeat(808),
      next_offset: null,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
