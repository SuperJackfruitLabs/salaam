// Routes to work outside the session: the native Toolkit owner, A2A grants, external harness
// workers, and integrating a worker's workspace back into its parent.
import { ServiceError, integer, object, readJson, string, type ChildTask } from '../core/index.js';
import { A2AInbound, type A2AInboundService } from '../a2a/index.js';
import type { ToolkitOwners } from '../toolkit/index.js';
import type { ChildWork, ExternalWork, WorkerWorkspaces } from '../workers/index.js';
import { send, NEXT, type Next, type RouteContext } from './router.js';

/** What an inbound A2A grant reads, and the workers and workspaces these routes act on. */
export interface IntegrationsService extends Omit<A2AInboundService, 'external' | 'children'> {
  readonly external: ExternalWork;
  readonly children: ChildWork;
  readonly toolkitOwners: ToolkitOwners;
  readonly workerWorkspaces: WorkerWorkspaces;
}

export class IntegrationsController {
  constructor(private readonly s: IntegrationsService) {}

  async toolkitVerify({ req, res }: RouteContext): Promise<void> {
    send(res, 200, await this.s.toolkitOwners.verify(req));
  }

  async toolkitControl({ req, res }: RouteContext): Promise<void> {
    send(res, 200, await this.s.toolkitOwners.control(req));
  }

  a2aGrant({ res, params }: RouteContext<'assignment'>): void {
    send(res, 200, A2AInbound.binding(this.s, params.assignment));
  }

  harnesses({ res }: RouteContext): void {
    send(res, 200, this.s.external.runtimes());
  }

  harness({ res, params }: RouteContext<'worker'>): void {
    const raw = this.externalWorker(params.worker);
    send(res, 200, {
      child: this.s.children.inspect(raw.parent_session, raw.id),
      execution: this.s.external.view(raw.id),
    });
  }

  async reconcileHarness({ req, res, params }: RouteContext<'worker'>): Promise<void> {
    const raw = this.externalWorker(params.worker);
    const body = object(await readJson(req));
    const result = await this.s.external.reconcile(
      raw,
      string(body.request_id, 'request_id', 128),
      string(body.run_id, 'run_id', 128),
      () =>
        this.s.store.authorizeControl(raw.parent_session, {
          client_id: string(body.client_id, 'client_id', 128),
          token: string(body.token, 'token', 128),
        }),
    );
    send(res, 200, result);
  }

  /** Any other route under one external worker: the worker must exist first. */
  unknownHarnessRoute({ params }: RouteContext<'worker'>): never {
    this.externalWorker(params.worker);
    return harnessRouteNotFound();
  }

  async resolveIntegration({ req, res, params }: RouteContext<'worker'>): Promise<void> {
    const body = object(await readJson(req)),
      controller = {
        client_id: string(body.client_id, 'client_id', 128),
        token: string(body.token, 'token', 128),
      },
      parent = this.s.workerWorkspaces.owner(params.worker);
    send(
      res,
      200,
      this.s.workerWorkspaces.resolve(
        params.worker,
        string(body.request_id, 'request_id', 128),
        integer(body.workspace_revision, 'workspace_revision'),
        string(body.workspace_digest, 'workspace_digest', 128),
        () => this.s.store.authorizeControl(parent, controller),
      ),
    );
  }

  integration({ res, params }: RouteContext<'worker'>): void {
    send(res, 200, this.s.workerWorkspaces.inspect(params.worker));
  }

  proposal({ res, url, params }: RouteContext<'worker'>): void {
    const parent = this.workerParent(params.worker);
    send(
      res,
      200,
      this.s.workerWorkspaces.proposal(
        parent,
        params.worker,
        integer(Number(url.searchParams.get('offset') ?? '0'), 'offset'),
      ),
    );
  }

  async integrate({ req, res, params }: RouteContext<'worker'>): Promise<void> {
    const parent = this.workerParent(params.worker);
    const body = object(await readJson(req)),
      controller = {
        client_id: string(body.client_id, 'client_id', 128),
        token: string(body.token, 'token', 128),
      };
    send(
      res,
      200,
      this.s.workerWorkspaces.integrate(
        parent,
        params.worker,
        string(body.request_id, 'request_id', 128),
        integer(body.workspace_revision, 'workspace_revision'),
        string(body.workspace_digest, 'workspace_digest', 128),
        string(body.patch_digest, 'patch_digest', 128),
        () => this.s.store.authorizeControl(parent, controller),
      ),
    );
  }

  /** Any other action on a worker: an unknown worker is not found; a known one falls through. */
  workerAction({ params }: RouteContext<'worker'>): Next {
    this.workerParent(params.worker);
    return NEXT;
  }

  private externalWorker(id: string): ChildTask {
    const raw = this.s.store.db
      .prepare('SELECT * FROM child_tasks WHERE id=?')
      .get(id) as unknown as ChildTask | undefined;
    if (!raw || !this.s.store.workerBoundary.view(raw.id).binding.external)
      throw new ServiceError('not_found', 'External worker not found', 404);
    return raw;
  }

  private workerParent(id: string): string {
    const child = this.s.store.db
      .prepare('SELECT parent_session FROM child_tasks WHERE id=?')
      .get(id);
    if (!child) throw new ServiceError('not_found', 'Worker not found', 404);
    return String(child.parent_session);
  }
}

export function harnessRouteNotFound(): never {
  throw new ServiceError('not_found', 'External worker route not found', 404);
}
