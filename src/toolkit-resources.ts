import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import type { Store } from './store.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import { canonical, digest, ServiceError } from './protocol.js';
import { processIdentity } from './supervisor.js';
import { ManagedStdioTransport, type StdioLaunch } from './mcp-stdio.js';

export interface ToolkitResourceSpec {
  id: string;
  session_id: string;
  root_digest: string;
  profile_digest: string;
  manifest_digest: string;
  state_dir: string;
  launch_digest: string;
}
export interface ToolkitResource {
  id: string;
  session_id: string;
  root_digest: string;
  profile_digest: string;
  state_dir: string;
  input_digest: string;
  spec: string;
  owner_boot: string;
  state: 'prepared' | 'launching' | 'running' | 'unconfirmed' | 'stopped';
  pid: number | null;
  identity: string | null;
  stop_digest: string | null;
  stop_receipt: string | null;
  revision: number;
}
interface StopProof {
  version: 1;
  scope: 'local_process_group';
  resource_id: string;
  root_digest: string;
  profile_digest: string;
  input_digest: string;
  pid: number | null;
  identity: string | null;
  method: 'not_started' | 'observed_exit';
  observer_boot: string;
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function exists(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}
function unavailable(): never {
  throw new ServiceError(
    'toolkit_resources_unconfirmed',
    'Toolkit broker ownership or local resources are unconfirmed',
  );
}
const hash = (s: unknown): boolean => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

/** Private controller resource ownership, NOT executable/profile admission or an
 * effect permission. Only a reviewed Toolkit parent may construct launches.
 * Saved records and events share the service journal transaction. Missing PID
 * records cannot be recovered by an empty map, a free flock or a PID scan. */
export class ToolkitResources {
  readonly boot = randomUUID();
  private active = new Map<string, ManagedStdioTransport>();
  private observed = new Map<string, { pid: number; identity: string | null }>();
  private blocked = new Set<string>();
  private closing = false;
  constructor(
    readonly store: Store,
    readonly authority?: AgentPodAuthority,
  ) {}
  get(id: string): ToolkitResource {
    const row = this.store.db
      .prepare('SELECT * FROM toolkit_resources WHERE id=?')
      .get(id) as unknown as ToolkitResource | undefined;
    if (!row) throw new ServiceError('not_found', 'Toolkit resource not found', 404);
    return row;
  }
  private event(row: ToolkitResource, state: ToolkitResource['state']): void {
    this.store.event(row.session_id, 'toolkit.resource.' + state, {
      resource_id: row.id,
      root_digest: row.root_digest,
      profile_digest: row.profile_digest,
    });
  }
  private current(row: Pick<ToolkitResource, 'session_id' | 'root_digest'>): void {
    if (!this.authority)
      throw new ServiceError(
        'authority_unavailable',
        'Toolkit resources require AgentPod authority',
      );
    if (digest(this.authority.binding(row.session_id)) !== row.root_digest)
      throw new ServiceError(
        'authority_binding',
        'Toolkit resource belongs to another execution root',
      );
  }
  transport(input: ToolkitResourceSpec, launch: StdioLaunch): ManagedStdioTransport {
    if (this.closing) unavailable();
    const spec = structuredClone(input);
    if (!this.authority)
      throw new ServiceError(
        'authority_unavailable',
        'Toolkit resources require AgentPod authority',
      );
    const binding = this.authority.binding(spec.session_id);
    const state = (() => {
      try {
        return lstatSync(spec.state_dir);
      } catch {
        unavailable();
      }
    })();
    let actualState: string;
    try {
      actualState = realpathSync(spec.state_dir);
    } catch {
      unavailable();
    }
    const rel = relative(binding.workspace, spec.state_dir);
    if (
      Object.keys(spec).sort().join(',') !==
        'id,launch_digest,manifest_digest,profile_digest,root_digest,session_id,state_dir' ||
      typeof spec.id !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(spec.id) ||
      !spec.session_id ||
      ![spec.root_digest, spec.profile_digest, spec.manifest_digest, spec.launch_digest].every(
        hash,
      ) ||
      !isAbsolute(spec.state_dir) ||
      resolve(spec.state_dir) !== spec.state_dir ||
      actualState !== spec.state_dir ||
      !state.isDirectory() ||
      (state.mode & 0o077) !== 0 ||
      state.uid !== process.getuid?.() ||
      !(rel === '..' || rel.startsWith('..' + sep)) ||
      digest(launch) !== spec.launch_digest
    )
      unavailable();
    this.current(spec);
    const fingerprint = digest(spec);
    this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT * FROM toolkit_resources WHERE id=?')
        .get(spec.id) as unknown as ToolkitResource | undefined;
      if (prior) {
        if (prior.input_digest !== fingerprint)
          throw new ServiceError('request_conflict', 'Toolkit resource ID has different input');
        unavailable(); // A process resource is single-use; saved call results belong to the call registry.
      }
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM toolkit_resources WHERE state!='stopped' AND (root_digest=? OR state_dir=?)",
          )
          .get(spec.root_digest, spec.state_dir)
      )
        unavailable();
      this.store.db
        .prepare(
          'INSERT INTO toolkit_resources(id,session_id,root_digest,profile_digest,state_dir,input_digest,spec,owner_boot,state) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          spec.id,
          spec.session_id,
          spec.root_digest,
          spec.profile_digest,
          spec.state_dir,
          fingerprint,
          canonical(spec),
          this.boot,
          'prepared',
        );
      this.event(this.get(spec.id), 'prepared');
    });
    const transport = new ManagedStdioTransport(launch, () => this.assertLive(spec.id), {
      starting: () => this.launching(spec.id),
      spawned: (pid) => this.spawned(spec.id, pid),
      failed: () => {
        this.blocked.add(spec.id);
      },
    });
    this.active.set(spec.id, transport);
    return transport;
  }
  launching(id: string): void {
    this.store.transaction(() => {
      const row = this.get(id);
      this.current(row);
      if (row.state !== 'prepared' || row.owner_boot !== this.boot) unavailable();
      this.store.db
        .prepare("UPDATE toolkit_resources SET state='launching',revision=revision+1 WHERE id=?")
        .run(id);
      this.event(row, 'launching');
    });
  }
  private spawned(id: string, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid < 1) unavailable();
    const identity = processIdentity(pid);
    // Retained only by the actual spawning controller, including when the
    // following database write fails. A reconstructed controller has no such proof.
    this.observed.set(id, { pid, identity });
    if (!identity) unavailable();
    this.store.transaction(() => {
      const row = this.get(id);
      this.current(row);
      if (row.state !== 'launching' || row.pid !== null || row.owner_boot !== this.boot)
        unavailable();
      this.store.db
        .prepare(
          "UPDATE toolkit_resources SET state='running',pid=?,identity=?,revision=revision+1 WHERE id=?",
        )
        .run(pid, identity, id);
      this.event(row, 'running');
    });
  }
  assertLive(id: string): void {
    const row = this.get(id);
    this.current(row);
    if (
      this.closing ||
      this.blocked.has(id) ||
      row.owner_boot !== this.boot ||
      !this.active.has(id) ||
      row.state !== 'running' ||
      !row.pid ||
      !row.identity ||
      processIdentity(row.pid) !== row.identity ||
      !exists(row.pid, true)
    )
      unavailable();
  }
  /** Inherited execution roots remain fenced across worker/daemon replacement. */
  assertSession(session: string): void {
    if (this.closing) unavailable();
    const rows = this.store.db
      .prepare(
        `WITH RECURSIVE owners(id) AS (
      SELECT ? UNION SELECT c.parent_session FROM child_tasks c JOIN owners o ON c.child_session=o.id
    ) SELECT r.id,r.state,r.owner_boot FROM toolkit_resources r JOIN owners o ON o.id=r.session_id WHERE r.state!='stopped'`,
      )
      .all(session);
    if (
      rows.some(
        (r) =>
          r.state === 'unconfirmed' || r.owner_boot !== this.boot || this.blocked.has(String(r.id)),
      )
    )
      unavailable();
  }
  stopped(session: string): boolean {
    return !this.store.db
      .prepare("SELECT 1 FROM toolkit_resources WHERE session_id=? AND state!='stopped'")
      .get(session);
  }
  async stopSession(session: string): Promise<void> {
    const results = await Promise.allSettled(
      this.store.db
        .prepare("SELECT id FROM toolkit_resources WHERE session_id=? AND state!='stopped'")
        .all(session)
        .map((r) => this.stop(String(r.id))),
    );
    if (results.some((r) => r.status === 'rejected')) unavailable();
  }
  stopProof(id: string): StopProof {
    const row = this.get(id);
    if (row.state !== 'stopped' || !row.stop_receipt || !row.stop_digest) unavailable();
    const proof = JSON.parse(row.stop_receipt) as StopProof;
    if (
      proof.version !== 1 ||
      proof.scope !== 'local_process_group' ||
      !['not_started', 'observed_exit'].includes(proof.method) ||
      (proof.method === 'not_started' && proof.pid !== null) ||
      typeof proof.observer_boot !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(proof.observer_boot) ||
      Object.keys(proof).sort().join(',') !==
        'identity,input_digest,method,observer_boot,pid,profile_digest,resource_id,root_digest,scope,version' ||
      digest(proof) !== row.stop_digest ||
      proof.resource_id !== id ||
      proof.root_digest !== row.root_digest ||
      proof.input_digest !== row.input_digest ||
      proof.profile_digest !== row.profile_digest ||
      proof.pid !== row.pid ||
      proof.identity !== row.identity
    )
      unavailable();
    return proof;
  }
  private unconfirmed(id: string): void {
    this.store.transaction(() => {
      const row = this.get(id);
      if (row.state === 'stopped' || row.state === 'unconfirmed') return;
      this.store.db
        .prepare("UPDATE toolkit_resources SET state='unconfirmed',revision=revision+1 WHERE id=?")
        .run(id);
      this.event(row, 'unconfirmed');
    });
  }
  async stop(id: string): Promise<void> {
    let row = this.get(id);
    if (row.state === 'stopped') {
      this.stopProof(id);
      return;
    }
    // This fence is immediate and survives a failed journal write in this
    // controller. A new controller cannot grant from an older owner_boot.
    this.blocked.add(id);
    const transport = this.active.get(id);
    if (transport) {
      try {
        await transport.close();
      } catch {
        this.unconfirmed(id);
        unavailable();
      }
    }
    row = this.get(id);
    const owned = this.observed.get(id),
      pid = row.pid ?? owned?.pid ?? null,
      identity = row.identity ?? owned?.identity ?? null;
    if (row.state !== 'prepared' && pid === null) {
      this.unconfirmed(id);
      unavailable();
    }
    if (pid !== null && (exists(pid) || exists(pid, true))) {
      // Only signal the exact recorded predecessor. A reused/missing/unreadable
      // leader identity never authorizes signalling an unrelated process/group.
      if (!identity || processIdentity(pid) !== identity) {
        this.unconfirmed(id);
        unavailable();
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.unconfirmed(id);
          unavailable();
        }
      }
      for (let i = 0; i < 10 && (exists(pid) || exists(pid, true)); i++) await wait(20);
      if (exists(pid) || exists(pid, true)) {
        if (processIdentity(pid) !== identity) {
          this.unconfirmed(id);
          unavailable();
        }
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
            this.unconfirmed(id);
            unavailable();
          }
        }
      }
      for (let i = 0; i < 50 && (exists(pid) || exists(pid, true)); i++) await wait(20);
    }
    if (pid !== null && (exists(pid) || exists(pid, true))) {
      this.unconfirmed(id);
      unavailable();
    }
    const proof: StopProof = {
      version: 1,
      scope: 'local_process_group',
      resource_id: id,
      root_digest: row.root_digest,
      profile_digest: row.profile_digest,
      input_digest: row.input_digest,
      pid,
      identity,
      method: pid === null ? 'not_started' : 'observed_exit',
      observer_boot: this.boot,
    };
    this.store.transaction(() => {
      const saved = this.get(id);
      if (saved.state === 'stopped') {
        this.stopProof(id);
        return;
      }
      this.store.db
        .prepare(
          "UPDATE toolkit_resources SET state='stopped',pid=?,identity=?,stop_receipt=?,stop_digest=?,revision=revision+1 WHERE id=?",
        )
        .run(pid, identity, canonical(proof), digest(proof), id);
      this.event(saved, 'stopped');
    });
    this.active.delete(id);
    this.observed.delete(id);
  }
  async recover(): Promise<{ stopped: string[]; unconfirmed: string[] }> {
    const result = { stopped: [] as string[], unconfirmed: [] as string[] };
    for (const row of this.store.db
      .prepare("SELECT id FROM toolkit_resources WHERE state!='stopped' ORDER BY rowid")
      .all()) {
      const id = String(row.id);
      try {
        await this.stop(id);
        result.stopped.push(id);
      } catch {
        result.unconfirmed.push(id);
      }
    }
    return result;
  }
  async close(): Promise<void> {
    this.closing = true;
    const result = await this.recover();
    if (result.unconfirmed.length) unavailable();
  }
}
