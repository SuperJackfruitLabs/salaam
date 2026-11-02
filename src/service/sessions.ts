// Sessions: listing and creating them, their state and snapshot, names, forks, a desk session's
// model route, resuming, activity, and the compactions they run.
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ServiceError,
  canonical,
  integer,
  object,
  readJson,
  string,
  type ReasoningLevel,
  type Session,
} from '../core/index.js';
import { providerRoute } from '../providers/index.js';
import { forkPiSession, type Supervisor, type TaskContext } from '../runtime/index.js';
import type { AgentPodAuthority, StationWork } from '../agentpod/index.js';
import type { Workspaces } from '../coding/index.js';
import type { McpWork } from '../mcp/index.js';
import type { Store } from '../store/index.js';
import type { JobWork, OperatorInbox, TaskDriver, TaskWork } from '../tasks/index.js';
import type { ToolkitWork } from '../toolkit/index.js';
import type { ChildWork } from '../workers/index.js';
import { pickerSummary } from './picker-summary.js';
import { send, NEXT, type Next, type RouteContext } from './router.js';

export interface SessionsService {
  readonly stateDir: string;
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly tasks: TaskContext;
  readonly workspaces: Workspaces;
  readonly agentpod?: AgentPodAuthority;
  readonly mcp?: McpWork;
  readonly toolkit?: ToolkitWork;
  readonly station?: StationWork;
  readonly children: ChildWork;
  readonly inbox: OperatorInbox;
  readonly jobs: JobWork;
  readonly taskWork: TaskWork;
  readonly taskDriver: TaskDriver;
}

/** The bytes of tool events the activity route may send. */
const ACTIVITY_BYTES = 1024 * 1024;
/** What one activity row costs beyond its payload. */
const ACTIVITY_ROW_OVERHEAD = 128;

const controllerOf = (body: Record<string, unknown>) => ({
  client_id: string(body.client_id, 'client_id', 128),
  token: string(body.token, 'token', 128),
});

export class SessionsController {
  constructor(private readonly s: SessionsService) {}

  list({ res }: RouteContext): void {
    send(
      res,
      200,
      this.s.store.sessions().map((x) => {
        const session = this.s.supervisor.inspect(x.id);
        return { ...session, ...pickerSummary(session, this.s.store) };
      }),
    );
  }

  async create({ req, res }: RouteContext): Promise<void> {
    if (this.s.agentpod)
      throw new ServiceError(
        'admission_required',
        'This daemon requires a trusted AgentPod admission; unbound session creation is disabled',
      );
    const body = object(await readJson(req));
    const cwd = this.workspaceOf(body);
    const selected = this.requestedRoute(body);
    if (body.local_workspace) {
      const saved = this.s.store.cachedRequest<Session>(
        'local-operator',
        string(body.request_id, 'request_id', 128),
        {
          kind: 'create',
          cwd,
          local: {
            workspace: true,
            route: selected,
            ...(body.local_coding ? { coding: true } : {}),
          },
        },
      );
      if (saved) {
        send(res, 201, saved);
        return;
      }
      if (this.s.mcp || this.s.toolkit || this.s.station)
        throw new ServiceError(
          'admission_required',
          'Local inspection cannot be combined with managed host capabilities',
        );
    }
    const preparedLocal = body.local_workspace
      ? await this.s.supervisor.prepareProviderRoute(selected).catch(() => {
          throw new ServiceError(
            'provider_auth_required',
            `Provider authentication or routing configuration is unavailable. Configure ${selected.provider} with sal auth login ${selected.provider} or sal auth set ${selected.provider}, then retry.`,
            400,
          );
        })
      : undefined;
    if (
      preparedLocal?.output_cap === false &&
      body.route !== undefined &&
      object(body.route).max_tokens !== undefined
    )
      throw new ServiceError(
        'provider_output_cap_unavailable',
        'This authentication route cannot enforce an output token cap; omit max_tokens for an interactive session.',
        400,
      );
    const local = body.local_workspace
      ? {
          workspace: true as const,
          coding: body.local_coding === true,
          requestedRoute: selected,
          route: preparedLocal!.route,
          outputCap: preparedLocal!.output_cap,
        }
      : undefined;
    const session = this.s.store.create(
      cwd,
      string(body.request_id, 'request_id', 128),
      body.coding === true,
      local,
    );
    if (body.coding) this.s.workspaces.import(session.id, cwd);
    if (this.s.store.session(session.id).state === 'stopped')
      void this.s.supervisor.start(session.id).catch(() => {});
    send(res, 201, session);
  }

  compaction({ res, params }: RouteContext<'compaction'>): void {
    send(res, 200, this.s.tasks.compaction(params.compaction));
  }

  async cancelCompaction({ req, res, params }: RouteContext<'compaction'>): Promise<void> {
    const work = this.s.tasks.compaction(params.compaction);
    const body = object(await readJson(req));
    send(
      res,
      202,
      this.s.supervisor.cancelCompaction(work.id, string(body.request_id, 'request_id', 128), () =>
        this.s.store.authorizeControl(work.session_id, controllerOf(body)),
      ),
    );
  }

  /** Any other route under a compaction: an unknown one is not found; a known one falls through. */
  compactionRoute({ params }: RouteContext<'compaction'>): Next {
    this.s.tasks.compaction(params.compaction);
    return NEXT;
  }

  async fork({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    if (this.s.agentpod)
      throw new ServiceError(
        'admission_required',
        'Managed station sessions cannot be forked locally',
      );
    const body = object(await readJson(req));
    const session = this.s.store.forkLocal(
      id,
      string(body.request_id, 'request_id', 128),
      integer(body.expected_revision, 'expected_revision'),
      controllerOf(body),
      (source, target) => {
        this.s.supervisor.assertIdle(id);
        const dir = join(this.s.stateDir, 'workers', target, 'sessions');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return forkPiSession(source.pi_session_file!, source.cwd, dir, target);
      },
    );
    send(res, 201, session);
  }

  name({ res, params }: RouteContext<'session'>): void {
    send(res, 200, { name: this.s.store.sessionName(params.session) ?? null });
  }

  async rename({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const body = object(await readJson(req));
    send(
      res,
      200,
      this.s.store.nameSession(
        params.session,
        string(body.request_id, 'request_id', 128),
        string(body.name, 'name', 120),
        controllerOf(body),
      ),
    );
  }

  /** The latest tool events, oldest first, within a byte budget. */
  activity({ res, params }: RouteContext<'session'>): void {
    const id = params.session;
    this.s.store.session(id);
    const rows = this.s.store.db
      .prepare(
        "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished') ORDER BY seq DESC LIMIT 200",
      )
      .all(id);
    let bytes = 0;
    const page = [];
    for (const row of rows) {
      bytes += Buffer.byteLength(String(row.payload)) + ACTIVITY_ROW_OVERHEAD;
      if (bytes > ACTIVITY_BYTES) break;
      page.push({ seq: row.seq, kind: row.kind, payload: JSON.parse(String(row.payload)) });
    }
    send(res, 200, page.reverse());
  }

  children({ res, params }: RouteContext<'session'>): void {
    this.s.store.session(params.session);
    send(res, 200, this.s.children.list(params.session));
  }

  usage({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.store.usage.summary(params.session));
  }

  view({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.supervisor.inspect(params.session));
  }

  async snapshot({ res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    send(res, 200, {
      ...this.s.store.snapshot(id),
      inbox: this.s.inbox.list(0, id).items,
      recurring_occurrence:
        this.s.store.db.prepare('SELECT * FROM recurring_occurrences WHERE session_id=?').get(id) ??
        null,
      ...this.s.supervisor.inspect(id),
      job: this.s.jobs.forSession(id) ? this.s.jobs.view(this.s.jobs.forSession(id)!.id) : null,
      work_task: this.s.taskWork.forSession(id)
        ? await this.s.taskDriver.viewAsync(this.s.taskWork.forSession(id)!.id)
        : null,
    });
  }

  toolMetadata({ res, url, params }: RouteContext<'session'>): void {
    send(
      res,
      200,
      this.s.store.toolMetadata(
        params.session,
        string(url.searchParams.get('call_id'), 'call_id', 512),
      ),
    );
  }

  /** Switch an interactive session's model route; it restarts on the new one. */
  async switchRoute({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    this.s.store.authorizeControl(id, controllerOf(body));
    if (!this.s.tasks.instructions!.applies(id))
      throw new ServiceError(
        'route_switch_unavailable',
        'Only interactive sessions can switch model mid-session',
        409,
      );
    this.s.supervisor.assertIdle(id);
    const input = object(body.route);
    const requested = providerRoute(
      string(input.provider, 'provider'),
      input.model === undefined ? undefined : string(input.model, 'model'),
      undefined,
      undefined,
      undefined,
      input.reasoning as ReasoningLevel | undefined,
    );
    const prepared = await this.s.supervisor.prepareProviderRoute(requested).catch(() => {
      throw new ServiceError(
        'provider_auth_required',
        `Configure ${requested.provider} with sal auth login ${requested.provider} or sal auth set ${requested.provider}, then retry.`,
        400,
      );
    });
    if (prepared.output_cap !== (this.s.store.localOutputCap(id) ?? true))
      throw new ServiceError(
        'provider_output_cap_changed',
        'That route enforces output caps differently; start a new session for it',
        409,
      );
    this.s.supervisor.assertIdle(id);
    this.s.store.switchRoute(id, prepared.route);
    await this.s.supervisor.stopSession(id);
    void this.s.supervisor.start(id).catch(() => {});
    send(res, 200, this.s.supervisor.inspect(id));
  }

  async resume({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    this.s.store.authorizeControl(id, controllerOf(body));
    this.s.store.execution.assert(id);
    const session = this.s.supervisor.inspect(id);
    if (
      session.provider_route &&
      canonical(session.provider_route) !== canonical(this.s.supervisor.routeFor(id))
    )
      throw new ServiceError(
        'provider_route_changed',
        'Restart the service with this session’s original provider route, or create a new session',
      );
    if (session.state !== 'ready' && session.state !== 'starting')
      void this.s.supervisor.start(id).catch(() => {});
    // Show the project instructions an interactive session will use before its first turn.
    try {
      this.s.tasks.instructions?.refresh(id);
    } catch {
      /* reported on the next turn */
    }
    send(res, 202, this.s.supervisor.inspect(id));
  }

  /** A new session's workspace, after checking how the request combines its options. */
  private workspaceOf(body: Record<string, unknown>): string {
    const cwd = realpathSync(string(body.cwd, 'cwd'));
    if (!statSync(cwd).isDirectory())
      throw new ServiceError('invalid_workspace', 'Workspace must be a directory', 400);
    if (body.coding !== undefined && typeof body.coding !== 'boolean')
      throw new ServiceError('invalid_field', 'coding must be a boolean', 400);
    if (body.coding && !this.s.workspaces.root)
      throw new ServiceError('coding_disabled', 'Start with an explicit --coding-root');
    if (
      body.local_coding !== undefined &&
      (typeof body.local_coding !== 'boolean' || !body.local_workspace)
    )
      throw new ServiceError('invalid_field', 'local_coding requires a local workspace');
    if (body.local_workspace !== undefined && typeof body.local_workspace !== 'boolean')
      throw new ServiceError('invalid_field', 'local_workspace must be a boolean', 400);
    if (body.local_workspace && body.coding)
      throw new ServiceError(
        'invalid_field',
        'Choose local inspection or an owned coding workspace',
        400,
      );
    if (body.route !== undefined && !body.local_workspace)
      throw new ServiceError(
        'invalid_field',
        'Session route selection requires a local workspace',
        400,
      );
    return cwd;
  }

  /** The route a new session asks for, or the service's own. */
  private requestedRoute(body: Record<string, unknown>) {
    if (body.route === undefined) return this.s.supervisor.route;
    const input = object(body.route);
    return providerRoute(
      string(input.provider, 'provider'),
      input.model === undefined ? undefined : string(input.model, 'model'),
      input.max_tokens === undefined ? undefined : integer(input.max_tokens, 'max_tokens'),
      undefined,
      undefined,
      input.reasoning as ReasoningLevel | undefined,
    );
  }
}
