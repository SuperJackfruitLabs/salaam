// A session's owned coding workspace and the commands run in it.
import { integer, object, readJson, string } from '../core/index.js';
import type { CodingWork, Workspaces } from '../coding/index.js';
import type { Supervisor } from '../runtime/index.js';
import type { Store } from '../store/index.js';
import { send, NEXT, type Next, type RouteContext } from './router.js';

export interface CodingService {
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly workspaces: Workspaces;
  readonly coding: CodingWork;
}

const offsetOf = (url: URL): number =>
  integer(Number(url.searchParams.get('offset') ?? 0), 'offset');

export class CodingController {
  constructor(private readonly s: CodingService) {}

  workspaceDiff({ res, url, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.workspaces.diff(params.session, offsetOf(url)));
  }

  workspace({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.workspaces.inspect(params.session));
  }

  async refreshWorkspace({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    send(
      res,
      200,
      this.s.workspaces.refresh(
        id,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        string(body.digest, 'digest', 128),
        () => {
          this.authorize(id, body);
          this.s.supervisor.assertIdle(id);
        },
      ),
    );
  }

  commands({ res, url, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.coding.list(params.session, url.searchParams.get('summary') === '1'));
  }

  commandLogs({ res, url, params }: RouteContext<'session' | 'command'>): void {
    send(res, 200, this.s.coding.logs(params.session, params.command, offsetOf(url)));
  }

  command({ res, params }: RouteContext<'session' | 'command'>): void {
    send(res, 200, this.s.coding.get(params.session, params.command));
  }

  async start({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    send(
      res,
      202,
      this.s.coding.start(id, null, body, () => {
        this.authorize(id, body);
        this.s.supervisor.assertIdle(id);
      }),
    );
  }

  async cancel({ req, res, params }: RouteContext<'session' | 'command'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    send(
      res,
      202,
      this.s.coding.cancel(id, params.command, string(body.request_id, 'request_id', 128), () =>
        this.authorize(id, body),
      ),
    );
  }

  async reconcile({ req, res, params }: RouteContext<'session' | 'command'>): Promise<void> {
    const body = object(await readJson(req));
    this.authorize(params.session, body);
    send(res, 202, this.s.coding.reconcile(params.session, params.command));
  }

  /** Any other command POST reads its body, then falls through. */
  async other({ req }: RouteContext<'session'>): Promise<Next> {
    object(await readJson(req));
    return NEXT;
  }

  private authorize(id: string, body: Record<string, unknown>): void {
    this.s.store.authorizeControl(id, {
      client_id: string(body.client_id, 'client_id', 128),
      token: string(body.token, 'token', 128),
    });
  }
}
