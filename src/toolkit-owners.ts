import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { ToolkitResources } from './toolkit-resources.js';
import type { ToolkitCalls } from './toolkit-calls.js';
import type { ToolkitAdmission } from './toolkit-admission.js';
import { canonical, digest, object, ServiceError } from './protocol.js';
import { toolkitRequest } from './toolkit-protocol.js';

function denied(): never {
  throw new ServiceError('toolkit_owner_unavailable', 'Private Toolkit owner is unavailable', 403);
}

/** Private work callback role only. No registration endpoint, no cleanup-role
 * fallback and no adoption of a predecessor's key after daemon recovery. */
export class ToolkitOwners {
  private active = new Map<
    string,
    { calls: ToolkitCalls; admission: ToolkitAdmission; keyDigest: string }
  >();
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
      this.store.event(resource.session_id, 'toolkit.owner.registered', {
        resource_id: resourceId,
      });
    });
    this.active.set(resourceId, { calls, admission, keyDigest });
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
      if (
        resource.owner_boot !== this.resources.boot ||
        active.keyDigest !==
          active.admission.ownerKeyDigest(
            this.resources.authority!.binding(resource.session_id),
            this.socket,
          )
      )
        denied();
      this.resources.assertLive(resourceId);
      return active.calls.verify(resourceId, phase as 'review' | 'admit' | 'dispatch', request);
    } catch {
      denied();
    } finally {
      clearTimeout(timer);
    }
  }
}
