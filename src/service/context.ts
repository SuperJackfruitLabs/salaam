// What a session's model is given: its agent profiles and their grants, the context admitted
// into it, its task facts and history, compaction, and the artifacts it keeps.
import type { IncomingMessage } from 'node:http';
import { ServiceError, digest, integer, object, readJson, string } from '../core/index.js';
import type { AgentProfiles, Supervisor, TaskContext } from '../runtime/index.js';
import type { Store } from '../store/index.js';
import { send, type RouteContext } from './router.js';

export interface ContextService {
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly tasks: TaskContext;
  readonly agents: AgentProfiles;
}

/** The most bytes a stored artifact's text may have. */
const ARTIFACT_TEXT_LIMIT = 256 * 1024;

const controllerOf = (body: Record<string, unknown>) => ({
  client_id: string(body.client_id, 'client_id', 128),
  token: string(body.token, 'token', 128),
});

export class ContextController {
  constructor(private readonly s: ContextService) {}

  agents({ res, url, params }: RouteContext<'session'>): void {
    const id = params.session;
    const profile = url.searchParams.get('profile');
    send(
      res,
      200,
      profile
        ? {
            ...this.s.agents.inspect(id, profile),
            digest: digest(this.s.agents.inspect(id, profile)),
          }
        : this.s.agents.list(id).map((p) => ({ ...p, digest: digest(p) })),
    );
  }

  async admitAgent({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const { body, controller, request } = await agentRequest(req);
    const facts =
      body.fact_ids === undefined
        ? []
        : Array.isArray(body.fact_ids)
          ? body.fact_ids.map((x) => string(x, 'fact_id', 128))
          : (() => {
              throw new ServiceError('invalid_field', 'fact_ids must be an array');
            })();
    send(
      res,
      201,
      await this.s.agents.admit(
        params.session,
        request,
        string(body.profile_id, 'profile_id', 128),
        string(body.expected_digest, 'expected_digest', 64),
        facts,
        controller,
      ),
    );
  }

  async revokeAgent({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const { body, controller, request } = await agentRequest(req);
    send(
      res,
      200,
      this.s.agents.revoke(
        params.session,
        string(body.grant_id, 'grant_id', 128),
        request,
        controller,
      ),
    );
  }

  async unknownAgentOperation({ req }: RouteContext<'session'>): Promise<never> {
    await agentRequest(req);
    throw new ServiceError('not_found', 'Agent operation not found', 404);
  }

  context({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.tasks.admitted!.inspect(params.session));
  }

  /** context/plan previews a selection; context/admit admits the reviewed one. */
  async admitContext({ req, res, parts, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const contexts = this.s.tasks.admitted!;
    const body = object(await readJson(req));
    const authorize = () => {
      this.s.store.authorizeControl(id, controllerOf(body));
      this.s.supervisor.assertIdle(id);
    };
    if (parts[4] === 'plan') {
      authorize();
      send(res, 200, contexts.plan(id, body.selection));
      return;
    }
    send(
      res,
      200,
      contexts.admit(
        id,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        string(body.digest, 'digest', 128),
        body.selection,
        authorize,
      ),
    );
  }

  task({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.tasks.state(params.session));
  }

  history({ res, url, params }: RouteContext<'session'>): void {
    send(
      res,
      200,
      this.s.tasks.history(
        params.session,
        Object.fromEntries(
          [...url.searchParams].map(([k, v]) => [k, k === 'offset' ? Number(v) : v]),
        ),
      ),
    );
  }

  /** task updates a fact, compact compacts the session, artifacts stores a text artifact. */
  async change({ req, res, parts, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    const authorize = () => {
      this.s.store.authorizeControl(id, controllerOf(body));
      this.s.supervisor.assertIdle(id);
    };
    const request = string(body.request_id, 'request_id', 128);
    if (parts[3] === 'artifacts') {
      send(
        res,
        201,
        this.s.tasks.putArtifact(
          id,
          request,
          string(body.text, 'text', ARTIFACT_TEXT_LIMIT),
          authorize,
        ),
      );
      return;
    }
    const expected = integer(body.expected_version, 'expected_version');
    send(
      res,
      parts[3] === 'compact' ? 202 : 200,
      parts[3] === 'task'
        ? this.s.tasks.update(id, request, expected, object(body.fact), authorize)
        : this.s.supervisor.compact(id, request, expected, authorize),
    );
  }
}

/** An agent grant change reads its body, controller lease and request ID first. */
async function agentRequest(req: IncomingMessage) {
  const body = object(await readJson(req));
  const controller = controllerOf(body);
  const request = string(body.request_id, 'request_id', 128);
  return { body, controller, request };
}
