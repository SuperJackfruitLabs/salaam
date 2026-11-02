// Station units: the bounded systemd units a station check runs in, each journaled before it
// launches and stopped with a durable proof (or left unconfirmed, fencing the station).
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from '../core/index.js';
import type { Store } from '../store/index.js';
import { stationUnavailable, type StationConfig } from './station-config.js';
import { StationSystemd } from './station-systemd.js';

/** How long a unit may run, how often it is polled, and the most output it may write. */
const UNIT_RUN_MS = 35000;
const UNIT_POLL_MS = 100;
const UNIT_OUTPUT_BYTES = 65536;

export interface UnitRow {
  id: string;
  session_id: string | null;
  call_id: string | null;
  context_digest: string;
  config_json: string;
  snapshot_path: string;
  output_path: string;
  unit_json: string | null;
  state: 'prepared' | 'launching' | 'running' | 'unconfirmed' | 'stopped';
  stop_json: string | null;
}

/** What the units need from the station: the journal, its configuration, its private directory
 * and the stops in flight, so converging stop owners share one observation. */
export interface StationUnitDeps {
  readonly store: Store;
  readonly config: StationConfig;
  readonly directory: string;
  readonly unitStops: Map<string, Promise<unknown>>;
}

export function stationUnit(deps: StationUnitDeps, id: string): UnitRow {
  const row = deps.store.db.prepare('SELECT * FROM station_units WHERE id=?').get(id) as unknown as
    UnitRow | undefined;
  if (!row) stationUnavailable();
  return row;
}
export function createStationUnit(
  deps: StationUnitDeps,
  session: string | null,
  call: string | null,
  context: string,
): UnitRow {
  const id = digest(['station-unit-v1', call ?? randomUUID(), context]),
    base = mkdtempSync(join(deps.directory, 'unit-'));
  const row: UnitRow = {
    id,
    session_id: session,
    call_id: call,
    context_digest: context,
    config_json: canonical(deps.config),
    snapshot_path: join(base, 'source'),
    output_path: join(base, 'output'),
    unit_json: null,
    state: 'prepared',
    stop_json: null,
  };
  writeFileSync(row.output_path, '', { mode: 0o600 });
  deps.store.transaction(() =>
    deps.store.db
      .prepare('INSERT INTO station_units VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        row.id,
        row.session_id,
        row.call_id,
        row.context_digest,
        row.config_json,
        row.snapshot_path,
        row.output_path,
        null,
        'prepared',
        null,
      ),
  );
  return row;
}
export async function executeStationUnit(
  deps: StationUnitDeps,
  row: UnitRow,
  command: string,
  grant: () => void,
): Promise<{ exit_code: number | null; output: string; cleanup: unknown }> {
  const runtime = new StationSystemd(JSON.parse(row.config_json));
  grant();
  deps.store.transaction(() =>
    deps.store.db
      .prepare("UPDATE station_units SET state='launching' WHERE id=? AND state='prepared'")
      .run(row.id),
  );
  try {
    await runtime.launch(row.id, row.context_digest, row.snapshot_path, row.output_path, command);
    let observed = await runtime.inspect(row.id, row.context_digest);
    if (!observed) stationUnavailable();
    deps.store.transaction(() =>
      deps.store.db
        .prepare(
          "UPDATE station_units SET state='running',unit_json=? WHERE id=? AND state='launching'",
        )
        .run(canonical(observed), row.id),
    );
    const until = Date.now() + UNIT_RUN_MS;
    while (observed.sub === 'running' || observed.sub === 'start' || observed.sub === 'start-pre') {
      grant();
      if (Date.now() > until) stationUnavailable();
      await new Promise((r) => setTimeout(r, UNIT_POLL_MS));
      const next = await runtime.inspect(row.id, row.context_digest);
      if (!next || next.invocation !== observed.invocation) stationUnavailable();
      observed = next;
    }
    const exit = observed.code === 1 ? observed.status : null,
      cleanup = await stopStationUnit(deps, row.id);
    const st = lstatSync(row.output_path);
    if (!st.isFile() || st.nlink !== 1 || st.size >= UNIT_OUTPUT_BYTES) stationUnavailable();
    return { exit_code: exit, output: readFileSync(row.output_path, 'utf8'), cleanup };
  } catch (error) {
    await stopStationUnit(deps, row.id);
    throw error;
  }
}
export function stopStationUnit(deps: StationUnitDeps, id: string): Promise<unknown> {
  const pending = deps.unitStops.get(id);
  if (pending) return pending;
  // Revocation, attempt cancellation and the executor finalizer can converge.
  // They must share one actual stop observation, not race stale row snapshots.
  const work = stopUnitOnce(deps, id);
  deps.unitStops.set(id, work);
  void work
    .finally(() => {
      if (deps.unitStops.get(id) === work) deps.unitStops.delete(id);
    })
    .catch(() => {});
  return work;
}
async function stopUnitOnce(deps: StationUnitDeps, id: string): Promise<unknown> {
  const row = stationUnit(deps, id);
  if (row.state === 'stopped') return JSON.parse(row.stop_json!);
  try {
    const proof =
      row.state === 'prepared'
        ? { version: 1, method: 'not_started' }
        : await new StationSystemd(JSON.parse(row.config_json)).stop(
            id,
            row.context_digest,
            row.unit_json ? JSON.parse(row.unit_json) : undefined,
          );
    deps.store.transaction(() =>
      deps.store.db
        .prepare("UPDATE station_units SET state='stopped',stop_json=? WHERE id=?")
        .run(canonical(proof), id),
    );
    if (
      !row.snapshot_path.startsWith(deps.directory + '/unit-') ||
      !row.snapshot_path.endsWith('/source')
    )
      stationUnavailable();
    rmSync(row.snapshot_path, { recursive: true, force: true });
    return proof;
  } catch {
    deps.store.transaction(() =>
      deps.store.db.prepare("UPDATE station_units SET state='unconfirmed' WHERE id=?").run(id),
    );
    stationUnavailable();
  }
}
