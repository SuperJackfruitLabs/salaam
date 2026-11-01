import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { ToolkitResources } from './resources.js';
import type { ToolkitCalls } from './calls.js';
import { ToolkitCleanupAdmission, type ToolkitAdmission } from './admission.js';
import { canonical, digest, object, ServiceError } from '../core/protocol.js';
import { toolkitRequest, toolkitControl } from './protocol.js';

function denied(): never {
  throw new ServiceError('toolkit_owner_unavailable', 'Private Toolkit owner is unavailable', 403);
}

/** Distinct private work and cleanup callback roles, with no public registration,
 * role fallback or adoption of a predecessor's key after daemon recovery. */
export class ToolkitOwners {
  private active = new Map<
    string,
    { calls: ToolkitCalls; admission: ToolkitAdmission; keyDigest: string }
  >();
  private controls = new Map<string, { admission: ToolkitCleanupAdmission; keyDigest: string }>();
  constructor(
    readonly store: Store,
    readonly resources: ToolkitResources,
    readonly socket: string,
  ) {}
  register(resourceId: string, calls: ToolkitCalls, admission: ToolkitAdmission): void {
    if (
      calls.store !== this.store ||
      calls.options.resources !== this.resources ||
      !this.resources.authority ||
      calls.options.authority !== this.resources.authority
    )
      denied();
    const resource = this.resources.get(resourceId);
    if (resource.state !== 'prepared' || resource.owner_boot !== this.resources.boot) denied();
    const binding = this.resources.authority.binding(resource.session_id),
      admitted = admission.launch(binding);
    if (
      resource.root_digest !== digest(binding) ||
      resource.profile_digest !== admitted.profile_digest ||
      resource.state_dir !== admitted.state_dir ||
      resource.input_digest !== digest(JSON.parse(resource.spec)) ||
      JSON.parse(resource.spec).launch_digest !== digest(admitted.launch) ||
      JSON.parse(resource.spec).manifest_digest !== admitted.manifest_digest
    )
      denied();
    const keyDigest = admission.ownerKeyDigest(binding, this.socket);
    this.store.transaction(() => {
      if (
        this.store.db
          .prepare('SELECT 1 FROM toolkit_owners WHERE resource_id=? OR key_digest=?')
          .get(resourceId, keyDigest)
      )
        denied();
      this.store.db.prepare('INSERT INTO toolkit_owners VALUES(?,?)').run(resourceId, keyDigest);
      const cleanup = admission.cleanup(this.resources, resourceId).reference;
      this.store.db
        .prepare('INSERT INTO toolkit_cleanup_profiles VALUES(?,?,?)')
        .run(resourceId, cleanup.path, cleanup.sha256);
      this.store.event(resource.session_id, 'toolkit.owner.registered', {
        resource_id: resourceId,
      });
    });
    this.active.set(resourceId, { calls, admission, keyDigest });
  }
  cleanup(resourceId: string): ToolkitCleanupAdmission {
    const profile = this.store.db
      .prepare(
        'SELECT profile_path,profile_digest FROM toolkit_cleanup_profiles WHERE resource_id=?',
      )
      .get(resourceId);
    if (!profile) denied();
    return new ToolkitCleanupAdmission(
      String(profile.profile_path),
      String(profile.profile_digest),
    );
  }
  registerControl(resourceId: string, admission: ToolkitCleanupAdmission): void {
    const resource = this.resources.get(resourceId),
      admitted = admission.launch(this.resources),
      spec = JSON.parse(resource.spec);
    if (
      resource.state !== 'prepared' ||
      resource.owner_boot !== this.resources.boot ||
      spec.cleanup?.predecessor_id !== admitted.predecessor_id ||
      spec.cleanup?.stop_proof_digest !== admitted.stop_proof_digest ||
      canonical(spec.cleanup?.profile_ref) !== canonical(admission.reference) ||
      spec.launch_digest !== digest(admitted.launch) ||
      spec.manifest_digest !== admitted.manifest_digest ||
      resource.input_digest !== digest(spec)
    )
      denied();
    this.store.transaction(() => {
      if (
        this.store.db
          .prepare('SELECT 1 FROM toolkit_owners WHERE resource_id=? OR key_digest=?')
          .get(resourceId, admitted.owner_key_digest)
      )
        denied();
      this.store.db
        .prepare('INSERT INTO toolkit_owners VALUES(?,?)')
        .run(resourceId, admitted.owner_key_digest);
      this.store.event(resource.session_id, 'toolkit.control_owner.registered', {
        resource_id: resourceId,
        predecessor_id: admitted.predecessor_id,
      });
    });
    this.controls.set(resourceId, { admission, keyDigest: admitted.owner_key_digest });
  }
  async control(req: IncomingMessage): Promise<unknown> {
    const authorization = req.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !/^Bearer [a-f0-9]{64}$/.test(authorization) ||
      req.headers['content-type'] !== 'application/json'
    )
      denied();
    const keyDigest = createHash('sha256').update(authorization.slice(7)).digest('hex'),
      owner = this.store.db
        .prepare('SELECT resource_id FROM toolkit_owners WHERE key_digest=?')
        .get(keyDigest),
      resourceId = owner ? String(owner.resource_id) : '',
      active = this.controls.get(resourceId);
    if (!active || active.keyDigest !== keyDigest) denied();
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => req.destroy(), 5000);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) denied();
        chunks.push(Buffer.from(chunk));
      }
      const control = toolkitControl(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
        resource = this.resources.get(resourceId),
        spec = JSON.parse(resource.spec),
        admitted = active.admission.launch(this.resources);
      if (
        canonical(control) !== canonical(spec.cleanup?.control) ||
        resource.owner_boot !== this.resources.boot ||
        active.keyDigest !== admitted.owner_key_digest ||
        spec.launch_digest !== digest(admitted.launch) ||
        spec.manifest_digest !== admitted.manifest_digest ||
        resource.input_digest !== digest(spec)
      )
        denied();
      this.resources.assertControlLive(resourceId);
      return { version: 1, control_digest: digest(control), decision: 'allowed' };
    } catch {
      denied();
    } finally {
      clearTimeout(timer);
    }
  }
  async verify(req: IncomingMessage): Promise<unknown> {
    const authorization = req.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !/^Bearer [a-f0-9]{64}$/.test(authorization) ||
      req.headers['content-type'] !== 'application/json'
    )
      denied();
    const keyDigest = createHash('sha256').update(authorization.slice(7)).digest('hex');
    const owner = this.store.db
      .prepare('SELECT resource_id FROM toolkit_owners WHERE key_digest=?')
      .get(keyDigest);
    const resourceId = owner ? String(owner.resource_id) : '',
      active = this.active.get(resourceId);
    if (!active || active.keyDigest !== keyDigest) denied();
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => req.destroy(), 5000);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 70000) denied();
        chunks.push(Buffer.from(chunk));
      }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const phase = body.phase;
      if (body.version !== 1 || !['review', 'admit', 'dispatch'].includes(String(phase))) denied();
      const request = toolkitRequest(body.request);
      if (canonical(body) !== canonical({ version: 1, phase, request })) denied();
      // Recheck the actual registered resource, private pins and root after body
      // acquisition, not only before a slow client begins transmitting.
      const resource = this.resources.get(resourceId);
      try {
        this.cleanup(resourceId).check(this.resources);
        if (
          resource.owner_boot !== this.resources.boot ||
          active.keyDigest !==
            active.admission.ownerKeyDigest(
              this.resources.authority!.binding(resource.session_id),
              this.socket,
            )
        )
          denied();
      } catch {
        this.resources.fence(resourceId);
        denied();
      }
      try {
        this.resources.assertLive(resourceId);
      } catch {
        if (resource.state === 'running') this.resources.fence(resourceId);
        denied();
      }
      return active.calls.verify(resourceId, phase as 'review' | 'admit' | 'dispatch', request);
    } catch {
      denied();
    } finally {
      clearTimeout(timer);
    }
  }
}
