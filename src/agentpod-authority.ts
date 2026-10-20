import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import {
  constants,
  openSync,
  fstatSync,
  closeSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import { canonical, digest, ServiceError, object, integer } from './protocol.js';
import {
  agentpodBinding,
  AGENTPOD_LEASE_MS,
  type AgentPodBinding,
  type AgentPodPins,
} from './agentpod-protocol.js';

interface Admission {
  id: string;
  session_id: string;
  hub_session_id: string;
  binding: string;
  digest: string;
  pins_digest: string;
  lease_sequence: number;
  expires_at: number;
  boot_id: string | null;
  monotonic_deadline: number | null;
  state: string;
}
function privateBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16384
    )
      throw Error('AgentPod control file must be owner-only and at most 16 KiB');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readAgentPodPins(configPath: string, state: string): AgentPodPins {
  const pins = Object.freeze(
    object(JSON.parse(privateBytes(configPath).toString())),
  ) as unknown as AgentPodPins;
  const p = pins;
  if (
    Object.keys(p).sort().join(',') !==
    ['version', 'organization_id', 'node_id', 'station_key', 'workspace'].sort().join(',')
  )
    throw Error('AgentPod pins contain unsupported fields');
  agentpodBinding({
    ...p,
    principal_id: 'prn_00000000000000000000',
    station_id: 'validate',
    occupancy_epoch: 1,
    hub_session_id: 'validate',
    run: { source: 'agentpod', id: 'validate', epoch: 1 },
  });
  if (
    p.station_key !==
    'salaam:' + createHash('sha256').update(p.workspace).digest('hex').slice(0, 16)
  )
    throw Error('AgentPod station key must identify the pinned workspace');
  if (realpathSync(p.workspace) !== p.workspace)
    throw Error('AgentPod workspace pin must be its canonical absolute path');
  if (state === p.workspace || state.startsWith(p.workspace.replace(/\/$/, '') + '/'))
    throw Error('AgentPod private daemon state must be outside the station workspace');
  return pins;
}

/** A local node admission, not an Accounts token issuer or a provider login. */
export class AgentPodAuthority {
  readonly boot = randomUUID();
  readonly pins: AgentPodPins;
  private key: Buffer;
  constructor(
    readonly store: Store,
    state: string,
    readonly configPath: string,
    readonly cancel: (attempt: string) => void,
    readonly ownedResourcesStopped: (session: string) => boolean = () => true,
  ) {
    this.pins = readAgentPodPins(configPath, state);
    const keyPath = join(state, 'agentpod-control-key');
    try {
      const fd = openSync(keyPath, 'wx', 0o600);
      try {
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const dir = openSync(state, 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    this.key = privateBytes(keyPath);
    if (this.key.length !== 32) throw Error('Invalid AgentPod control key');
    store.agentpodAuthorityCheck = (session) => this.assert(this.bySession(session));
    store.requireAgentPodAuthority = true;
  }
  private row(id: string): Admission {
    const row = this.store.db
      .prepare('SELECT * FROM agentpod_admissions WHERE id=?')
      .get(id) as unknown as Admission | undefined;
    if (!row) throw new ServiceError('admission_not_found', 'AgentPod admission not found', 404);
    return row;
  }
  bySession(session: string): Admission {
    const row = this.store.db
      .prepare('SELECT * FROM agentpod_admissions WHERE session_id=?')
      .get(session) as unknown as Admission | undefined;
    if (!row) throw new ServiceError('admission_not_found', 'Session has no AgentPod admission');
    return row;
  }
  binding(session: string): AgentPodBinding {
    const row = this.bySession(session);
    this.assert(row);
    return JSON.parse(row.binding) as AgentPodBinding;
  }
  /** Fresh admission lease data for a separately owned native operation. This
   * consumes no effect permission. The caller must also bind its actual worker,
   * attempt, process resource and exact operation before granting dispatch.
   * Keep the immutable invocation/review deadline separate from this duration. */
  leaseWindow(session: string, expectedBindingDigest: string, maximumMs: number): number {
    if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > AGENTPOD_LEASE_MS)
      throw new ServiceError('invalid_authority_window', 'Invalid native authority duration', 400);
    const row = this.bySession(session);
    this.assert(row);
    if (row.digest !== expectedBindingDigest)
      throw new ServiceError(
        'authority_binding',
        'Native operation belongs to a different execution root',
      );
    const remaining = Math.floor(
      Math.min(maximumMs, row.expires_at - Date.now(), row.monotonic_deadline! - performance.now()),
    );
    if (!Number.isFinite(remaining) || remaining < 1)
      throw new ServiceError(
        'authority_expired',
        'AgentPod authority lease has no remaining native grant window',
      );
    return remaining;
  }
  private checked(input: unknown): AgentPodBinding {
    const b = agentpodBinding(input);
    for (const k of Object.keys(this.pins) as (keyof AgentPodPins)[])
      if (this.pins[k] !== b[k])
        throw new ServiceError(
          'authority_binding',
          'AgentPod organization, node, station or workspace binding differs from the reviewed pins',
        );
    return b;
  }
  private bound(input: unknown): Admission {
    const b = this.checked(input);
    const row = this.store.db
      .prepare('SELECT id FROM agentpod_admissions WHERE hub_session_id=?')
      .get(b.hub_session_id);
    if (!row) throw new ServiceError('admission_not_found', 'AgentPod admission not found');
    const admission = this.row(String(row.id));
    if (
      admission.binding !== canonical(b) ||
      admission.digest !== digest(b) ||
      admission.pins_digest !== digest(this.pins)
    )
      throw new ServiceError('authority_binding', 'AgentPod authority binding changed');
    return admission;
  }
  assert(row: Admission): void {
    if (this.store.execution.revocation(row.session_id))
      throw new ServiceError('session_revoked', 'Session execution authority revoked');
    const binding = this.checked(JSON.parse(row.binding));
    const high = this.store.db
      .prepare(
        'SELECT occupancy_epoch,principal_id FROM agentpod_station_epochs WHERE station_id=?',
      )
      .get(binding.station_id);
    if (
      row.binding !== canonical(binding) ||
      row.digest !== digest(binding) ||
      row.hub_session_id !== binding.hub_session_id ||
      !high ||
      Number(high.occupancy_epoch) !== binding.occupancy_epoch ||
      high.principal_id !== binding.principal_id
    )
      throw new ServiceError(
        'authority_binding',
        'AgentPod admission integrity or occupant generation changed',
      );
    if (
      row.pins_digest !== digest(this.pins) ||
      row.state !== 'active' ||
      row.boot_id !== this.boot ||
      row.expires_at <= Date.now() ||
      row.monotonic_deadline === null ||
      row.monotonic_deadline <= performance.now()
    )
      throw new ServiceError(
        'authority_expired',
        'AgentPod authority lease is not fresh for this daemon',
      );
    this.store.nativeResourceCheck?.(row.session_id);
  }
  token(id: string): string {
    return createHmac('sha256', this.key)
      .update('agentpod-admission-v1:' + id)
      .digest('base64url');
  }
  authenticate(id: string, token: string): { session_id: string; binding: AgentPodBinding } {
    const expected = Buffer.from(this.token(id)),
      supplied = Buffer.from(token);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
      throw new ServiceError('unauthorized', 'Invalid AgentPod admission credential', 403);
    const row = this.row(id);
    this.assert(row);
    return { session_id: row.session_id, binding: JSON.parse(row.binding) };
  }
  admit(input: unknown, request: string) {
    const b = this.checked(input);
    const admitted = this.store.request(
      'agentpod-node',
      request,
      { kind: 'admit', binding: b },
      () => {
        const old = this.store.db
          .prepare('SELECT id FROM agentpod_admissions WHERE hub_session_id=?')
          .get(b.hub_session_id);
        if (old) return { admission_id: this.bound(b).id };
        if (
          this.store.db
            .prepare('SELECT 1 FROM agentpod_admissions WHERE run_key=?')
            .get(canonical({ org: b.organization_id, run: b.run }))
        )
          throw new ServiceError(
            'run_already_admitted',
            'This work-run epoch already has a durable execution; recover its original admission',
          );
        const runHigh = this.store.db
          .prepare(
            "SELECT MAX(json_extract(binding,'$.run.epoch')) AS epoch FROM agentpod_admissions WHERE json_extract(binding,'$.organization_id')=? AND json_extract(binding,'$.run.source')=? AND json_extract(binding,'$.run.id')=?",
          )
          .get(b.organization_id, b.run.source, b.run.id);
        if (runHigh?.epoch !== null && Number(runHigh?.epoch) > b.run.epoch)
          throw new ServiceError('stale_run_epoch', 'AgentPod work-run epoch is stale');
        const high = this.store.db
          .prepare(
            'SELECT occupancy_epoch,principal_id FROM agentpod_station_epochs WHERE station_id=?',
          )
          .get(b.station_id);
        if (
          high &&
          (Number(high.occupancy_epoch) > b.occupancy_epoch ||
            (Number(high.occupancy_epoch) === b.occupancy_epoch &&
              high.principal_id !== b.principal_id))
        )
          throw new ServiceError('stale_occupancy', 'Station occupancy epoch is stale');
        for (const r of this.store.db.prepare('SELECT id FROM agentpod_admissions').all()) {
          const prior = this.row(String(r.id));
          if (
            !this.store.execution.revocation(prior.session_id) ||
            !this.status(prior).owned_execution_stopped ||
            this.status(prior).unresolved_operations.length
          )
            throw new ServiceError(
              'execution_unconfirmed',
              'Prior station execution must be revoked, stopped and reconciled before replacement',
            );
        }
        this.store.db
          .prepare(
            'INSERT INTO agentpod_station_epochs VALUES (?,?,?) ON CONFLICT(station_id) DO UPDATE SET occupancy_epoch=excluded.occupancy_epoch,principal_id=excluded.principal_id',
          )
          .run(b.station_id, b.occupancy_epoch, b.principal_id);
        const session = randomUUID(),
          id = randomUUID();
        this.store.db
          .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
          .run(session, b.workspace, session);
        this.store.event(
          session,
          'session.created',
          { cwd: b.workspace, authority: 'agentpod-v1' },
          request,
        );
        this.store.db
          .prepare(
            'INSERT INTO agentpod_admissions(id,session_id,hub_session_id,run_key,binding,digest,pins_digest,expires_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            session,
            b.hub_session_id,
            canonical({ org: b.organization_id, run: b.run }),
            canonical(b),
            digest(b),
            digest(this.pins),
            Date.now() + AGENTPOD_LEASE_MS,
          );
        this.store.event(
          session,
          'agentpod.admitted',
          { admission_id: id, binding_digest: digest(b), binding: b },
          request,
        );
        return { admission_id: id };
      },
    );
    const row = this.row(admitted.admission_id);
    return { ...this.status(row), token: this.token(row.id) };
  }
  renew(input: unknown, request: string, sequence: number) {
    const b = this.checked(input);
    integer(sequence, 'lease_sequence');
    return this.store.request(
      'agentpod-node',
      request,
      { kind: 'renew', binding: b, sequence },
      () => {
        const row = this.bound(b);
        if (
          row.state === 'revoked' ||
          this.store.execution.revocation(row.session_id) ||
          row.expires_at <= Date.now() ||
          (row.boot_id === this.boot &&
            row.monotonic_deadline !== null &&
            row.monotonic_deadline <= performance.now())
        )
          throw new ServiceError(
            'authority_expired',
            'Expired or revoked authority cannot be renewed',
          );
        this.store.nativeResourceCheck?.(row.session_id);
        if (sequence <= row.lease_sequence)
          throw new ServiceError('stale_authority', 'Authority lease sequence is stale');
        this.store.db
          .prepare(
            "UPDATE agentpod_admissions SET lease_sequence=?,expires_at=?,boot_id=?,monotonic_deadline=?,state='active' WHERE id=?",
          )
          .run(
            sequence,
            Date.now() + AGENTPOD_LEASE_MS,
            this.boot,
            performance.now() + AGENTPOD_LEASE_MS,
            row.id,
          );
        this.store.event(
          row.session_id,
          'agentpod.renewed',
          { admission_id: row.id, lease_sequence: sequence },
          request,
        );
        return this.status(this.row(row.id));
      },
    );
  }
  revoke(input: unknown, request: string, reason: string) {
    const b = this.checked(input);
    this.store.request('agentpod-node', request, { kind: 'revoke', binding: b, reason }, () => {
      let row: Admission;
      try {
        row = this.bound(b);
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== 'admission_not_found') throw error;
        // A stop that overtakes admission persists a tombstone; a late admit cannot start work.
        const session = randomUUID(),
          id = randomUUID();
        this.store.db
          .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
          .run(session, b.workspace, session);
        this.store.event(
          session,
          'session.created',
          { cwd: b.workspace, authority: 'agentpod-revocation-tombstone' },
          request,
        );
        this.store.db
          .prepare(
            'INSERT INTO agentpod_admissions(id,session_id,hub_session_id,run_key,binding,digest,pins_digest,expires_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            session,
            b.hub_session_id,
            'tombstone:' + b.hub_session_id,
            canonical(b),
            digest(b),
            digest(this.pins),
            0,
          );
        row = this.row(id);
      }
      this.store.execution.revokeInTransaction(row.session_id, request, reason, this.cancel);
      this.store.db
        .prepare("UPDATE agentpod_admissions SET state='revoked' WHERE id=?")
        .run(row.id);
      return { admission_id: row.id };
    });
    return this.status(this.bound(b));
  }
  expired(): AgentPodBinding[] {
    return (
      this.store.db
        .prepare("SELECT * FROM agentpod_admissions WHERE state!='revoked'")
        .all() as unknown as Admission[]
    )
      .filter(
        (r) =>
          r.expires_at <= Date.now() ||
          (r.boot_id === this.boot &&
            r.monotonic_deadline !== null &&
            r.monotonic_deadline <= performance.now()),
      )
      .map((r) => JSON.parse(r.binding));
  }
  inspect(input: unknown) {
    return this.status(this.bound(input));
  }
  private status(row: Admission) {
    const ids = this.store.db
      .prepare(
        `WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT c.child_session FROM child_tasks c JOIN owned o ON c.parent_session=o.id) SELECT id FROM owned`,
      )
      .all(row.session_id)
      .map((r) => String(r.id));
    const unresolved_operations = ids.flatMap((id) =>
      this.store.db
        .prepare("SELECT id FROM operations WHERE session_id=? AND state='outcome_unknown'")
        .all(id)
        .map((r) => String(r.id)),
    );
    const stopped = ids.every(
      (id) =>
        this.ownedResourcesStopped(id) &&
        !this.store.db
          .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
          .get(id) &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM command_runs WHERE session_id=? AND state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
          )
          .get(id) &&
        !this.store.db
          .prepare(
            'SELECT 1 FROM external_runs e JOIN child_tasks c ON c.id=e.child_id WHERE c.child_session=? AND e.stopped=0',
          )
          .get(id),
    );
    let authorized = false;
    try {
      this.assert(row);
      authorized = true;
    } catch {}
    return {
      admission_id: row.id,
      session_id: row.session_id,
      binding: JSON.parse(row.binding) as AgentPodBinding,
      binding_digest: row.digest,
      lease_sequence: row.lease_sequence,
      expires_at: row.expires_at,
      authorized,
      revoked: !!this.store.execution.revocation(row.session_id),
      owned_execution_stopped: stopped,
      unresolved_operations,
      active_attempts: this.store.db
        .prepare(
          "SELECT id FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running','delegated')",
        )
        .all(row.session_id)
        .map((r) => String(r.id)),
      interrupted_attempts: this.store.db
        .prepare(
          "SELECT id FROM attempts WHERE session_id=? AND state='interrupted' AND resolved_by IS NULL",
        )
        .all(row.session_id)
        .map((r) => String(r.id)),
    };
  }
}
