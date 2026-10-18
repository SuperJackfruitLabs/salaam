import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { canonical, digest, textDigest, ServiceError, type ChildTask } from './protocol.js';
import { POLICY_DIGEST } from './config.js';
import type { ProviderRoute } from './provider-config.js';
import type { AgentProfile, AgentGrant, AgentProfiles } from './agent-profiles.js';

/** Local contract v1. These are enforced capabilities, not upstream feature claims. */
export const NATIVE_CAPABILITIES = {
  schema_version: 1,
  runtime: 'native-pi',
  model_requests: true,
  output_cap: 'authentication-dependent',
  usage_receipts: true,
  resume_dispatch: false,
  confirmed_stop: false,
  files: false,
  commands: false,
  isolation: 'managed-process-no-coding-authority',
  retention: 'durable-local',
} as const;
export const DIAGNOSTIC_PROFILE = {
  schema_version: 1,
  id: 'salaam/diagnostic',
  revision: 1,
  tools: ['salaam_probe'],
  max_depth: 1,
} as const;
export function nativeCapabilities(
  profile: AgentProfile,
  coordination = false,
  isolation?: WorkerBinding['isolation'],
) {
  const caps = profile.role
    ? {
        ...NATIVE_CAPABILITIES,
        repository_read: profile.tools.includes('salaam_repository'),
        findings: profile.tools.includes('salaam_findings'),
      }
    : NATIVE_CAPABILITIES;
  return {
    ...caps,
    ...(coordination ? { team_messages: true } : {}),
    ...(isolation
      ? {
          files: profile.tools.includes('salaam_files'),
          commands: profile.tools.includes('salaam_command'),
          isolation:
            isolation.execution.evidence === 'fixture'
              ? 'simulated-owned-copy'
              : 'owned-copy-and-proven-executor',
          execution_profile: isolation.execution.profile_digest,
          execution_engine: isolation.execution.engine_id,
        }
      : {}),
  };
}

export interface WorkerBinding {
  schema_version: 1;
  worker_id: string;
  runtime: 'native-pi';
  owner_session: string;
  owner_task: string | null;
  parent_attempt: string;
  step_key: string;
  session_id: string;
  attempt_id: string;
  input_digest: string;
  input_artifact: string | null;
  profile: AgentProfile;
  profile_digest: string;
  capabilities: ReturnType<typeof nativeCapabilities>;
  capability_digest: string;
  tools: string[];
  route: ProviderRoute | null;
  workspace: { id: string; revision: number; digest: string } | null;
  policy_digest: string;
  bounds: { scope: 'model-requests'; requests: number };
  legacy: boolean;
  agent?: AgentGrant;
  repository?: { artifact_id: string; base_artifact: string; digest: string };
  assignment?: { id: string; generation: number };
  isolation?: {
    workspace_id: string;
    baseline_artifact: string;
    digest: string;
    execution: { profile_digest: string; engine_id: string; evidence: 'proven' | 'fixture' };
  };
}
export interface WorkerBoundaryView {
  binding: WorkerBinding;
  binding_digest: string;
  generation: number;
  worker_epoch: number | null;
  dispatch_state: 'intent' | 'dispatching' | 'accepted' | 'interrupted' | 'terminal';
}

/** Never equate one opaque invocation with one model request. No opaque adapter is enabled. */
export function assertModelRequestBoundary(capabilities: {
  schema_version: number;
  model_requests: boolean;
}): void {
  if (capabilities.schema_version !== 1)
    throw new ServiceError('worker_capability_version', 'Unsupported worker capability version');
  if (capabilities.model_requests !== true)
    throw new ServiceError(
      'worker_budget_scope',
      'Model-request bounds require enforced model-request admission; invocation-only workers are disabled',
    );
}

export class WorkerBoundary {
  profiles?: AgentProfiles;
  assertAssignment?: (binding: WorkerBinding) => void;
  assertIsolation?: (binding: WorkerBinding) => void;
  constructor(private store: Store) {}
  /** Called within the schema migration transaction. Cached responses and child rows stay intact. */
  migrate(): void {
    this.store.db.exec(`
      CREATE TABLE worker_profiles(id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,revision));
      CREATE TABLE child_workers(child_id TEXT PRIMARY KEY REFERENCES child_tasks(id),binding TEXT NOT NULL,binding_digest TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,worker_epoch INTEGER,dispatch_state TEXT NOT NULL);
      CREATE UNIQUE INDEX child_worker_identity ON child_workers(json_extract(binding,'$.worker_id'));
    `);
    for (const child of this.store.db
      .prepare('SELECT * FROM child_tasks')
      .all() as unknown as ChildTask[]) {
      this.freeze(child, null, true);
      this.store.db
        .prepare('UPDATE child_workers SET dispatch_state=? WHERE child_id=?')
        .run(child.state === 'accepted' ? 'interrupted' : 'terminal', child.id);
    }
  }
  /** Caller owns the transaction that creates the child, its reservation and input artifact. */
  freeze(
    child: ChildTask,
    inputArtifact: string | null,
    legacy = false,
    agent?: AgentGrant,
    repository?: WorkerBinding['repository'],
    assignment?: WorkerBinding['assignment'],
    isolation?: WorkerBinding['isolation'],
  ): void {
    const admittedProfile = agent?.profile ?? DIAGNOSTIC_PROFILE;
    const profileDigest = digest(admittedProfile);
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO worker_profiles(id,revision,digest,document) VALUES (?,?,?,?)',
      )
      .run(admittedProfile.id, admittedProfile.revision, profileDigest, canonical(admittedProfile));
    const profile = this.store.db
      .prepare('SELECT digest,revoked FROM worker_profiles WHERE id=? AND revision=?')
      .get(admittedProfile.id, admittedProfile.revision);
    if (profile?.revoked || profile?.digest !== profileDigest)
      throw new ServiceError(
        'worker_profile_revoked',
        'Diagnostic worker profile is revoked or changed',
      );
    const task = this.store.db
      .prepare('SELECT id FROM durable_tasks WHERE session_id=?')
      .get(child.parent_session);
    const workspace = this.store.db
      .prepare('SELECT id,revision,digest FROM workspaces WHERE session_id=?')
      .get(child.parent_session);
    const binding: WorkerBinding = {
      schema_version: 1,
      worker_id: randomUUID(),
      runtime: 'native-pi',
      owner_session: child.parent_session,
      owner_task: task ? String(task.id) : null,
      parent_attempt: child.parent_attempt,
      step_key: child.step_key,
      session_id: child.child_session,
      attempt_id: child.child_attempt,
      input_digest: child.input_digest,
      input_artifact: inputArtifact,
      profile: admittedProfile,
      profile_digest: profileDigest,
      capabilities: nativeCapabilities(admittedProfile, !!assignment, isolation),
      capability_digest: digest(nativeCapabilities(admittedProfile, !!assignment, isolation)),
      tools: JSON.parse(child.authority),
      route:
        agent?.route ??
        this.store.providerRoute(child.child_session) ??
        this.store.providerRoute(child.parent_session),
      workspace: workspace
        ? {
            id: String(workspace.id),
            revision: Number(workspace.revision),
            digest: String(workspace.digest),
          }
        : null,
      policy_digest: POLICY_DIGEST,
      bounds: { scope: 'model-requests', requests: child.budget },
      legacy,
      ...(agent ? { agent } : {}),
      ...(repository ? { repository } : {}),
      ...(assignment ? { assignment } : {}),
      ...(isolation ? { isolation } : {}),
    };
    assertModelRequestBoundary(binding.capabilities);
    this.store.db
      .prepare(
        "INSERT INTO child_workers(child_id,binding,binding_digest,dispatch_state) VALUES (?,?,?,'intent')",
      )
      .run(child.id, canonical(binding), digest(binding));
    // Migration has no event publication; the child itself remains the legacy receipt.
    if (!legacy)
      this.store.event(child.parent_session, 'child.worker_intent', {
        child_id: child.id,
        worker_id: binding.worker_id,
        binding_digest: digest(binding),
      });
  }
  view(childId: string): WorkerBoundaryView {
    const row = this.store.db.prepare('SELECT * FROM child_workers WHERE child_id=?').get(childId);
    if (!row) throw new ServiceError('worker_binding_missing', 'Child has no worker binding');
    return {
      binding: JSON.parse(String(row.binding)),
      binding_digest: String(row.binding_digest),
      generation: Number(row.generation),
      worker_epoch: row.worker_epoch === null ? null : Number(row.worker_epoch),
      dispatch_state: row.dispatch_state as WorkerBoundaryView['dispatch_state'],
    };
  }
  private validate(child: ChildTask, route: ProviderRoute): WorkerBoundaryView {
    const view = this.view(child.id),
      b = view.binding;
    if (b.agent) {
      if (
        !this.profiles ||
        b.agent.owner_session !== child.parent_session ||
        b.agent.profile_digest !== b.profile_digest ||
        canonical(b.agent.route) !== canonical(b.route)
      )
        throw new ServiceError(
          'worker_binding_changed',
          'Specialist admission belongs to another owner or route',
        );
      this.profiles.validate(b.agent);
    }
    const profile = this.store.db
      .prepare('SELECT * FROM worker_profiles WHERE id=? AND revision=?')
      .get(b.profile.id, b.profile.revision);
    if (b.tools.some((t) => ['salaam_files', 'salaam_command'].includes(t)) && !b.isolation)
      throw new ServiceError(
        'worker_binding_changed',
        'Coding workers require isolated workspace ownership',
      );
    if (b.isolation) {
      if (!this.assertIsolation)
        throw new ServiceError('worker_binding_changed', 'Execution boundary is unavailable');
      this.assertIsolation(b);
    }
    if (b.assignment) {
      if (!this.assertAssignment)
        throw new ServiceError('worker_binding_changed', 'Assignment owner is unavailable');
      this.assertAssignment(b);
    }
    const task = this.store.db
      .prepare('SELECT id FROM durable_tasks WHERE session_id=?')
      .get(child.parent_session);
    const input = this.store.db
      .prepare(
        'SELECT s.text,a.digest,a.session_id FROM submissions s JOIN artifacts a ON a.id=? WHERE s.attempt_id=?',
      )
      .get(b.input_artifact, child.child_attempt);
    if (
      b.schema_version !== 1 ||
      digest(b) !== view.binding_digest ||
      b.runtime !== 'native-pi' ||
      b.owner_session !== child.parent_session ||
      b.owner_task !== (task ? String(task.id) : null) ||
      b.parent_attempt !== child.parent_attempt ||
      b.session_id !== child.child_session ||
      b.attempt_id !== child.child_attempt ||
      b.step_key !== child.step_key ||
      b.input_digest !== child.input_digest ||
      !input ||
      input.session_id !== child.child_session ||
      input.digest !== textDigest(String(input.text)) ||
      b.bounds.scope !== 'model-requests' ||
      b.bounds.requests !== child.budget ||
      canonical(b.tools) !== child.authority ||
      b.tools.some(
        (tool) => !b.profile.tools.includes(tool) && !(tool === 'salaam_team' && b.assignment),
      ) ||
      b.policy_digest !== POLICY_DIGEST ||
      canonical(b.route) !== canonical(route) ||
      b.capability_digest !== digest(nativeCapabilities(b.profile, !!b.assignment, b.isolation)) ||
      digest(b.capabilities) !== b.capability_digest ||
      (!b.agent && b.profile_digest !== digest(DIAGNOSTIC_PROFILE)) ||
      digest(b.profile) !== b.profile_digest ||
      !profile ||
      profile.revoked ||
      profile.digest !== b.profile_digest ||
      digest(JSON.parse(String(profile.document))) !== b.profile_digest
    )
      throw new ServiceError(
        'worker_binding_changed',
        'Frozen worker owner, profile, capabilities or configuration changed',
      );
    assertModelRequestBoundary(b.capabilities);
    return view;
  }
  /** Commit dispatch intent before launching a process. It can be claimed only once. */
  claim(child: ChildTask, epoch: number, route: ProviderRoute): void {
    this.store.transaction(() => {
      const view = this.validate(child, route);
      if (
        view.dispatch_state !== 'intent' ||
        child.state !== 'accepted' ||
        this.store.cancelled(child.child_attempt)
      )
        throw new ServiceError(
          'worker_already_dispatched',
          'Child worker dispatch cannot be replayed',
        );
      this.store.assertEpoch(child.child_session, epoch);
      this.store.db
        .prepare(
          "UPDATE child_workers SET generation=generation+1,worker_epoch=?,dispatch_state='dispatching' WHERE child_id=?",
        )
        .run(epoch, child.id);
      this.store.event(child.parent_session, 'child.worker_dispatching', {
        child_id: child.id,
        worker_id: view.binding.worker_id,
        generation: view.generation + 1,
        worker_epoch: epoch,
      });
    });
  }
  assert(child: ChildTask, epoch: number, route: ProviderRoute): WorkerBoundaryView {
    const view = this.validate(child, route);
    this.store.assertEpoch(child.child_session, epoch);
    if (
      view.generation !== 1 ||
      view.worker_epoch !== epoch ||
      !['dispatching', 'accepted'].includes(view.dispatch_state) ||
      child.state !== 'accepted' ||
      this.store.cancelled(child.child_attempt)
    )
      throw new ServiceError('stale_worker', 'Worker generation no longer owns this child');
    return view;
  }
  accepted(child: ChildTask, epoch: number, route: ProviderRoute): void {
    this.store.transaction(() => {
      const view = this.assert(child, epoch, route);
      if (view.dispatch_state !== 'dispatching')
        throw new ServiceError('worker_already_dispatched', 'Duplicate worker acceptance');
      this.store.db
        .prepare("UPDATE child_workers SET dispatch_state='accepted' WHERE child_id=?")
        .run(child.id);
      this.store.event(child.parent_session, 'child.worker_accepted', {
        child_id: child.id,
        worker_id: view.binding.worker_id,
        generation: view.generation,
        worker_epoch: epoch,
      });
    });
  }
  /** Called with the terminal child result in the same transaction. */
  finish(child: ChildTask, interrupted: boolean): void {
    this.store.db
      .prepare('UPDATE child_workers SET dispatch_state=? WHERE child_id=?')
      .run(interrupted ? 'interrupted' : 'terminal', child.id);
  }
}
