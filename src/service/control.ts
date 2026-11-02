// Who may drive a session: the AgentPod authority's admissions and leases, the managed MCP
// assignment that rides on them, a session's controller lease, and revocation.
import type { IncomingMessage } from 'node:http';
import { ServiceError, integer, object, readJson, string } from '../core/index.js';
import type { AgentPodAuthority, AgentPodWork } from '../agentpod/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { McpWork } from '../mcp/index.js';
import type { Supervisor } from '../runtime/index.js';
import type { SessionRevocation, Store } from '../store/index.js';
import type { StationWork } from '../agentpod/index.js';
import { send, type RouteContext } from './router.js';

export interface ControlService {
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly agentpod?: AgentPodAuthority;
  readonly agentpodWork?: AgentPodWork;
  readonly agentpodWorkProgression: boolean;
  readonly managed: ManagedWork;
  readonly mcp?: McpWork;
  readonly station?: StationWork;
  /** Stops a revoked session's resources after its receipt has committed. */
  scheduleRevocationStop(receipt: SessionRevocation): void;
}

/** Every AgentPod route needs the reviewed authority, then reads its body. */
export async function authorityRequest(
  agentpod: AgentPodAuthority | undefined,
  req: IncomingMessage,
): Promise<{ authority: AgentPodAuthority; body: Record<string, unknown> }> {
  if (!agentpod)
    throw new ServiceError(
      'authority_disabled',
      'AgentPod authority requires reviewed --agentpod-config pins',
    );
  return { authority: agentpod, body: object(await readJson(req)) };
}

export class ControlController {
  constructor(private readonly s: ControlService) {}

  async attach({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    const attached = authority.authenticate(
      string(body.admission_id, 'admission_id', 128),
      string(body.token, 'token', 128),
    );
    send(res, 200, {
      ...attached,
      ...(this.s.agentpodWorkProgression &&
      this.s.agentpodWork &&
      attached.binding.run.source === 'superpipeline'
        ? { work_control: { version: 1, owner: 'superpipeline' } }
        : {}),
      ...(this.s.mcp ? { managed_mcp: this.s.mcp.status(attached.session_id).assignment } : {}),
    });
  }

  async status({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    send(res, 200, authority.inspect(body.binding));
  }

  async assignMcp({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.mcp)
      throw new ServiceError('mcp_disabled', 'No reviewed managed MCP host profile', 403);
    const current = authority.inspect(body.binding);
    const old = this.s.mcp.status(current.session_id).assignment;
    const assigned = this.s.mcp.assign(current.session_id, body.assignment);
    if (old && old.assignment_digest !== assigned.assignment_digest) {
      this.s.supervisor.failControl(
        current.session_id,
        new Error('MCP assignment changed; restart required'),
      );
      await Promise.all([
        this.s.supervisor.stopSession(current.session_id),
        this.s.mcp.stopSession(current.session_id),
      ]);
    }
    send(res, 200, await this.s.mcp.ready(current.session_id));
  }

  async admit({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    const request = string(body.request_id, 'request_id', 128);
    send(
      res,
      200,
      authority.admit(
        body.binding,
        request,
        body.continue_from === undefined
          ? undefined
          : string(body.continue_from, 'continue_from', 128),
        body.approval_rules,
      ),
    );
  }

  async renew({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    const request = string(body.request_id, 'request_id', 128);
    send(
      res,
      200,
      authority.renew(
        body.binding,
        request,
        integer(body.lease_sequence, 'lease_sequence'),
        body.approval_rules,
      ),
    );
  }

  async revokeAdmission({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    const request = string(body.request_id, 'request_id', 128);
    const status = authority.revoke(body.binding, request, string(body.reason, 'reason', 1024));
    this.s.scheduleRevocationStop(this.s.store.execution.revocation(status.session_id)!);
    send(res, 202, status);
  }

  async unknownAuthorityMethod({ req }: RouteContext): Promise<never> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    string(body.request_id, 'request_id', 128);
    throw new ServiceError('not_found', 'Unknown AgentPod authority method', 404);
  }

  /** A controller lease: acquire, renew, release or take over. */
  async control({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const body = object(await readJson(req));
    const action = string(body.action, 'action');
    if (!['acquire', 'renew', 'release', 'takeover'].includes(action))
      throw new ServiceError('invalid_field', 'Invalid control action', 400);
    send(
      res,
      200,
      this.s.store.control(
        params.session,
        string(body.request_id, 'request_id', 128),
        string(body.client_id, 'client_id', 128),
        action as 'acquire' | 'renew' | 'release' | 'takeover',
        integer(body.expected_epoch, 'expected_epoch'),
        body.token === undefined ? undefined : string(body.token, 'token', 128),
      ),
    );
  }

  revocation({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.store.execution.revocation(params.session));
  }

  async revoke({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    const request = string(body.request_id, 'request_id', 128);
    const receipt = this.s.store.execution.revoke(
      id,
      request,
      integer(body.expected_revision, 'expected_revision'),
      string(body.reason, 'reason', 1024),
      {
        client_id: string(body.client_id, 'client_id', 128),
        token: string(body.token, 'token', 128),
      },
      (attempt) => {
        this.s.managed.cancelInTransaction(attempt, request, 'session-revocation');
        this.s.mcp?.cancelInTransaction(attempt, 'session-revocation');
        this.s.station?.cancelInTransaction(attempt);
      },
    );
    // The receipt commits before any asynchronous process/executor cleanup.
    // Cleanup failure never restores authority or implies a confirmed stop.
    this.s.scheduleRevocationStop(receipt);
    send(res, 202, receipt);
  }
}
