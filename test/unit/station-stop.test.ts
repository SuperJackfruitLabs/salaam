import { expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { StationWork } from '../../src/agentpod/station-work.js';
import { StationSystemd } from '../../src/agentpod/station-systemd.js';

// Real durable unit journal; controlled systemd stop barrier. This is concurrency
// conformance, not an OS cgroup proof (the Linux acceptance owns that evidence).
function fixture() {
  const dir = mkdtempSync('/tmp/sal-stop-'),
    store = new Store(join(dir, 'journal.sqlite'));
  const work = Object.assign(Object.create(StationWork.prototype), {
    store,
    directory: dir,
    config: {},
    unitStops: new Map(),
  }) as any;
  const row = work.createUnit(null, null, 'b'.repeat(64));
  store.db
    .prepare("UPDATE station_units SET state='running',unit_json=? WHERE id=?")
    .run(JSON.stringify({ invocation: 'c'.repeat(32) }), row.id);
  return {
    work,
    row,
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('concurrent station stop owners await one exact durable stop proof', async () => {
  const f = fixture();
  let release!: (value: any) => void;
  const stop = vi.spyOn(StationSystemd.prototype, 'stop').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const proof = {
    version: 1 as const,
    unit: 'owned',
    invocation: 'c'.repeat(32),
    cgroup: 'owned',
    observed_empty: true as const,
  };
  try {
    const a = f.work.stopUnit(f.row.id),
      b = f.work.stopUnit(f.row.id);
    expect(a).toBe(b);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.work.unit(f.row.id).state).toBe('running');
    release(proof);
    expect(await a).toEqual(proof);
    expect(await b).toEqual(proof);
    expect(f.work.unit(f.row.id).state).toBe('stopped');
    expect(await f.work.stopUnit(f.row.id)).toEqual(proof);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    stop.mockRestore();
    f.close();
  }
});

test('a shared failed stop preserves uncertainty; a later call needs fresh actual proof', async () => {
  const f = fixture();
  let reject!: (reason: Error) => void;
  const stop = vi.spyOn(StationSystemd.prototype, 'stop').mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  try {
    const a = f.work.stopUnit(f.row.id),
      b = f.work.stopUnit(f.row.id);
    const outcomes = Promise.allSettled([a, b]);
    reject(Error('unconfirmed fixture stop'));
    expect((await outcomes).every((x) => x.status === 'rejected')).toBe(true);
    expect(f.work.unit(f.row.id).state).toBe('unconfirmed');
    expect(f.work.unit(f.row.id).stop_json).toBe(null);
    const proof = {
      version: 1 as const,
      unit: 'owned',
      invocation: 'c'.repeat(32),
      cgroup: 'owned',
      observed_empty: true as const,
    };
    stop.mockResolvedValue(proof);
    expect(await f.work.stopUnit(f.row.id)).toEqual(proof);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(f.work.unit(f.row.id).state).toBe('stopped');
  } finally {
    stop.mockRestore();
    f.close();
  }
});
