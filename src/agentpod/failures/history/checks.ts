// The station of the historical read-only check: every task check passed on the station it was
// bound to, with its unit's stop proof, and every other station call is a stopped read of a
// proven tree (or the one boundary write).
import { canonical, digest } from '../../../core/index.js';
import { requiredChecks } from '../../../tasks/index.js';
import type { Row } from '../rule.js';
import {
  stopProof,
  type AppliedPatch,
  type History,
  type HistoryRun,
  type Unapplied,
} from './context.js';

/** What a passed check proved: its call, the tree it checked and the configuration it ran in. */
export interface CheckProof {
  call: Row;
  tree: string;
  config: string;
}

/** The task's checks and the station's calls, units and observations, with each check's proof. */
export interface StationHistory {
  checks: Row[];
  calls: Row[];
  units: Row[];
  observed: Row[];
  proofByCheck: Map<string, CheckProof>;
}

/** What a check is checked against: the station calls and units, and the plan digest. */
interface CheckJournal {
  calls: Row[];
  units: Row[];
  plan: string;
}

/** The task's checks, each passed and proven, and the station journal around them. */
export function taskChecks(h: History, run: HistoryRun): StationHistory {
  const { require, rows, session, task, runtime } = h;
  const { sessions, marks } = run;
  const checks = rows('checks', 'SELECT * FROM task_checks WHERE task_id=?', task.id);
  require(runtime.verification_runs === checks.length);
  const calls = rows(
    'station_calls',
    `SELECT * FROM station_calls WHERE session_id IN (${marks})`,
    ...sessions,
  );
  const units = rows(
    'station_units',
    `SELECT * FROM station_units WHERE session_id IN (${marks}) OR session_id IS NULL`,
    ...sessions,
  );
  const observed = rows(
    'verification_observed',
    "SELECT * FROM events WHERE session_id=? AND kind='station.verification_observed'",
    session,
  );
  const plan = digest({
    objective: task.objective,
    constraints: task.constraints,
    acceptance: task.acceptance,
    ...(task.completion_gate ? { completion_gate: task.completion_gate } : {}),
    deliverables: task.deliverables,
    limits: task.limits,
    steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
      key,
      title,
      instruction,
      depends_on,
      checks,
    })),
  });
  const proofByCheck = new Map<string, CheckProof>();
  for (const check of checks)
    proofByCheck.set(String(check.id), taskCheckProof(h, { calls, units, plan }, check));
  return { checks, calls, units, observed, proofByCheck };
}

/** A check's saved binding: its evidence, the bound station and its own check call. */
function boundCheck(h: History, journal: CheckJournal, check: Row) {
  const { require, artifact, store, session, root, task, runtime, originalVerification } = h;
  const { calls, plan } = journal;
  const evidence = artifact(check.artifact_id, session);
  const saved = store.db
    .prepare("SELECT * FROM requests WHERE actor='station-task-check' AND id=?")
    .get(String(check.id));
  require(saved);
  const bindingArtifact = JSON.parse(String(saved!.response)),
    bound = artifact(bindingArtifact, session);
  const call = calls.find((c) => c.id === bound.call_id),
    configured = requiredChecks(task).find((c) => c.key === check.check_key);
  require(
    check.state === 'passed' &&
      check.plan_revision === task.plan_revision &&
      check.engine_id === 'linux-systemd-station-v1' &&
      check.command_run_id === null &&
      call &&
      configured?.cwd === '.' &&
      (check.step_id === null ||
        task.steps.some((s) => s.id === check.step_id && s.checks?.includes(check.check_key))),
  );
  const c = call!,
    args = JSON.parse(String(c.args_json)),
    station = bound.station;
  require(
    bound.version === 1 &&
      bound.check_id === check.id &&
      bound.task_id === task.id &&
      bound.plan_revision === task.plan_revision &&
      bound.plan_digest === plan &&
      bound.check_digest ===
        digest({
          id: check.id,
          task: task.id,
          key: check.check_key,
          step: check.step_id,
          plan_revision: task.plan_revision,
        }) &&
      bound.call_digest ===
        digest({
          id: c.id,
          session: c.session_id,
          epoch: c.worker_epoch,
          attempt: c.attempt_id,
          tool: c.tool_call_id,
          kind: c.kind,
          input: c.input_digest,
          root: c.root_digest,
          configuration: c.configuration_digest,
          args: c.args_json,
        }) &&
      saved!.hash === digest({ checkID: check.id, callID: c.id }) &&
      station?.version === 1 &&
      station.runner === 'linux-systemd-station-v1' &&
      canonical(station) === canonical(originalVerification) &&
      (runtime.auto_binding === null ||
        canonical(JSON.parse(String(runtime.auto_binding))) === canonical(station)) &&
      station.root_digest === root &&
      station.configuration_digest === c.configuration_digest &&
      station.network === 'none' &&
      station.command_workspace === 'read-only-reviewed-snapshot' &&
      check.workspace_id === 'station:' + root &&
      check.workspace_revision === 0 &&
      check.workspace_digest === bound.tree_digest &&
      check.profile_digest === c.configuration_digest &&
      c.session_id === session &&
      c.kind === 'check' &&
      c.task_check_id === check.id &&
      c.tool_call_id === 'task-check:' + check.id &&
      c.attempt_id === null &&
      canonical(args) ===
        canonical({
          action: 'check',
          command: configured!.command,
          expected_tree: bound.tree_digest,
        }),
  );
  return { evidence, bindingArtifact, bound, c };
}

/** A check's result, unit stop proof and evidence agree; returns what it proved. */
function taskCheckProof(h: History, journal: CheckJournal, check: Row): CheckProof {
  const { require, session, root, task } = h;
  const { units } = journal;
  const { evidence, bindingArtifact, bound, c } = boundCheck(h, journal, check);
  const result = JSON.parse(String(c.result_json)),
    unit = units.find((u) => u.call_id === c.id);
  require(
    unit &&
      unit.session_id === session &&
      unit.context_digest ===
        digest({
          id: c.id,
          root,
          configuration: c.configuration_digest,
          input: c.input_digest,
        }) &&
      digest(JSON.parse(String(unit.config_json))) === c.configuration_digest &&
      unit.unit_json,
  );
  const stop = stopProof(h, unit!),
    description = JSON.parse(String(unit!.unit_json));
  require(
    description.id === stop.unit &&
      description.cgroup === stop.cgroup &&
      description.invocation === stop.invocation &&
      canonical(result.cleanup) === canonical(stop) &&
      result.exit_code === 0 &&
      result.verified_check === true &&
      result.expected_tree === bound.tree_digest &&
      result.observed_tree === bound.tree_digest &&
      result.network === 'none' &&
      result.workspace === 'read-only-reviewed-snapshot',
  );
  require(
    canonical(evidence) ===
      canonical({
        version: 1,
        backend: 'linux-systemd-station-v1',
        binding_artifact: bindingArtifact,
        check_id: check.id,
        call_id: c.id,
        plan_revision: task.plan_revision,
        root_digest: root,
        configuration_digest: c.configuration_digest,
        tree_digest: bound.tree_digest,
        result_digest: digest(result),
      }),
  );
  return { call: c, tree: bound.tree_digest, config: c.configuration_digest };
}

/** Every station call is a proven read or check (or a boundary write), every unit stopped. */
export function stationCalls(
  h: History,
  station: StationHistory,
  unapplied: Unapplied | null,
  appliedPatch: AppliedPatch | null,
): void {
  const { require, session } = h;
  const { checks, calls, units, proofByCheck } = station;
  const appliedCall = appliedPatch?.call ?? null;
  require(
    !unapplied ||
      (calls.some((c) => canonical(c) === canonical(unapplied.call)) &&
        [...proofByCheck.values()].some(
          (p) => p.tree === JSON.parse(String(unapplied.call.args_json)).expected_tree,
        )),
  );
  if (appliedCall) {
    const args = JSON.parse(String(appliedCall.args_json)),
      result = JSON.parse(String(appliedCall.result_json));
    require(
      calls.some((c) => canonical(c) === canonical(appliedCall)) &&
        [...proofByCheck.values()].every(
          (p) => p.tree === args.expected_tree || p.tree === result.tree_digest,
        ),
    );
  }
  for (const call of calls) stationCall(h, station, call, unapplied, appliedPatch);
  for (const unit of units) {
    if (unit.session_id === null) {
      require(unit.call_id === null);
      stopProof(h, unit);
    } else
      require(
        unit.session_id === session &&
          checks.some((c) => proofByCheck.get(String(c.id))?.call.id === unit.call_id),
      );
  }
}

/** One station call other than a boundary write: a stopped read or check of a proven tree. */
function stationCall(
  h: History,
  station: StationHistory,
  call: Row,
  unapplied: Unapplied | null,
  appliedPatch: AppliedPatch | null,
): void {
  const { require, session, root } = h;
  const { observed, proofByCheck } = station;
  const appliedCall = appliedPatch?.call ?? null,
    appliedTransition = appliedPatch?.transition ?? null;
  if (appliedCall && canonical(call) === canonical(appliedCall)) return;
  if (unapplied && canonical(call) === canonical(unapplied.call)) return;
  require(
    call.session_id === session &&
      call.root_digest === root &&
      call.operation_id === null &&
      call.state === 'returned' &&
      ['read', 'check'].includes(call.kind) &&
      call.helper_state === 'stopped' &&
      call.helper_stop_json &&
      call.helper_identity &&
      call.helper_pid > 0 &&
      call.input_digest === digest(JSON.parse(String(call.args_json))),
  );
  const stop = JSON.parse(String(call.helper_stop_json));
  require(
    stop.version === 1 &&
      stop.scope === 'local_process_group' &&
      stop.method === 'observed_exit' &&
      stop.pid === call.helper_pid &&
      stop.identity === call.helper_identity,
  );
  const proof = proofByCheck.get(String(call.task_check_id));
  require(proof && call.configuration_digest === proof.config);
  if (call.kind === 'check') require(proof!.call.id === call.id);
  else {
    require(
      call.attempt_id === null &&
        call.tool_call_id === call.id &&
        call.result_json === null &&
        canonical(JSON.parse(String(call.args_json))) === canonical({ action: 'inspect' }),
    );
    require(
      observed.some((e) => {
        const p = JSON.parse(String(e.payload));
        return (
          p.inspection_call === call.id &&
          (p.tree_digest === proof!.tree ||
            (appliedTransition &&
              proof!.tree === appliedTransition.before &&
              p.tree_digest === appliedTransition.after &&
              Number(e.seq) > appliedTransition.settled)) &&
          (p.source_call === proof!.call.id ||
            canonical(p.source_call) === canonical({ task_check_id: call.task_check_id }))
        );
      }),
    );
  }
}
