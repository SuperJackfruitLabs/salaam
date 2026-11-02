// A desk session's own controls: approval rules, the permission policy, the command reviewer,
// hooks, background commands, and the local diff and edits.
import { ServiceError, integer, object, readJson, string } from '../core/index.js';
import {
  configurePermissions,
  localDiff,
  permissionPolicy,
  type LocalCoding,
} from '../local/index.js';
import type { Supervisor } from '../runtime/index.js';
import type { Store } from '../store/index.js';
import type { CommandReviewers } from './reviewers.js';
import { send, NEXT, type Next, type RouteContext } from './router.js';

export interface DeskService {
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly localCoding: LocalCoding;
  readonly reviewers: CommandReviewers;
  /** Phase 2b: whether interactive sessions here may choose full access (no OS sandbox). */
  readonly allowFullAccessSessions: boolean;
  readonly allowYoloSessions: boolean;
}

const controllerOf = (body: Record<string, unknown>) => ({
  client_id: string(body.client_id, 'client_id', 128),
  token: string(body.token, 'token', 128),
});

export class DeskController {
  constructor(private readonly s: DeskService) {}

  // Desk-session approval rules (phase 2a): list, add (from a reviewed operation or written out),
  // and remove. Adding or removing needs the session's control lease, like the permission policy.

  approvalRules({ res, params }: RouteContext<'session'>): void {
    const id = params.session;
    const rules = this.s.localCoding.rules!;
    send(res, 200, {
      applies: rules.applies(id),
      rules: rules.list(id),
      problems: rules.problems(id),
    });
  }

  async addApprovalRule(ctx: RouteContext<'session'>): Promise<void> {
    const id = ctx.params.session;
    const rules = this.s.localCoding.rules!;
    const body = await this.leased(ctx);
    const scope = string(body.scope, 'scope');
    if (scope !== 'session' && scope !== 'repo')
      throw new ServiceError('invalid_field', 'A rule scope is session or repo', 400);
    const request = string(body.request_id, 'request_id', 128);
    send(
      ctx.res,
      200,
      body.operation_id !== undefined
        ? rules.addFromOperation(id, string(body.operation_id, 'operation_id', 128), scope, request)
        : rules.add(id, scope, body.rule, request),
    );
  }

  async removeApprovalRule(ctx: RouteContext<'session' | 'rule'>): Promise<void> {
    const rules = this.s.localCoding.rules!;
    await this.leased(ctx);
    rules.remove(ctx.params.session, string(ctx.params.rule, 'rule', 128));
    send(ctx.res, 200, { removed: ctx.params.rule });
  }

  /** Any other request on the rules reads its body and checks the lease, then falls through. */
  async approvalRulesOther(ctx: RouteContext<'session'>): Promise<Next> {
    await this.leased(ctx);
    return NEXT;
  }

  permissions({ res, params }: RouteContext<'session'>): void {
    const id = params.session;
    const store = this.s.store;
    send(res, 200, {
      policy: permissionPolicy(store, id),
      configurable: store.localWorkspace(id),
      coding: store.localCoding(id),
      // Desk coding sessions: approval rules and auto mode can approve commands (Phase 2a/2b).
      command_auto_approval: store.localCoding(id),
      full_access_allowed: this.s.allowFullAccessSessions,
      yolo_allowed: this.s.allowYoloSessions && !!this.s.localCoding.rules?.applies(id),
      ...(store.localCoding(id) ? { command_sandbox: this.s.localCoding.commandSandbox(id) } : {}),
    });
  }

  async configurePermissions({ req, res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    const body = object(await readJson(req));
    send(
      res,
      200,
      configurePermissions(
        this.s.store,
        id,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        body.policy,
        controllerOf(body),
        {
          allowFullAccess: this.s.allowFullAccessSessions,
          allowYolo: this.s.allowYoloSessions,
          deskSession: !!this.s.localCoding.rules?.applies(id),
        },
      ),
    );
  }

  reviewer({ res, params }: RouteContext<'session'>): void {
    send(res, 200, this.s.reviewers.view(this.s.store, params.session));
  }

  async chooseReviewer(ctx: RouteContext<'session'>): Promise<void> {
    const id = ctx.params.session;
    const reviewers = this.s.reviewers;
    const body = await this.leased(ctx);
    // `enabled` is the earlier on/off form: on means the config's default.
    const choice =
      typeof body.enabled === 'boolean'
        ? body.enabled
          ? reviewers.default === 'off'
            ? [...reviewers.options.keys()][0]
            : reviewers.default
          : 'off'
        : string(body.choice, 'choice', 64);
    if (!reviewers.options.size && choice !== 'off')
      throw new ServiceError(
        'classifier_unavailable',
        'No command reviewer is configured on this host (--danger-classifier-config)',
      );
    if (reviewers.pin !== undefined)
      throw new ServiceError(
        'classifier_pinned',
        `This host pinned the command reviewer (${reviewers.pin}); sessions cannot change it`,
        403,
      );
    if (choice !== 'off' && !reviewers.options.has(choice ?? ''))
      throw new ServiceError('invalid_field', `Unknown reviewer ${choice}`);
    if (reviewers.options.size)
      this.s.store.transaction(() => {
        this.s.store.db
          .prepare(
            'INSERT INTO danger_classifier_choice(session_id,choice) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET choice=excluded.choice',
          )
          .run(id, choice!);
        this.s.store.event(id, 'permission.classifier-set', { choice });
      });
    send(ctx.res, 200, reviewers.view(this.s.store, id));
  }

  // Desk-session hooks (Phase 4b): list, trust the reviewed repository file, or revoke it. Hooks
  // routes exist only when the supervisor has hooks; they run only in your own desk sessions.

  hooks({ res, params }: RouteContext<'session'>): void | Next {
    const hooks = this.hooksFor(params.session);
    if (!hooks) return NEXT;
    send(res, 200, { sources: hooks.sources(params.session) });
  }

  async trustHooks(ctx: RouteContext<'session'>): Promise<void | Next> {
    const hooks = this.hooksFor(ctx.params.session);
    if (!hooks) return NEXT;
    const body = await this.leased(ctx);
    send(ctx.res, 200, hooks.trust(ctx.params.session, string(body.digest, 'digest', 128)));
  }

  async revokeHooks(ctx: RouteContext<'session'>): Promise<void | Next> {
    const hooks = this.hooksFor(ctx.params.session);
    if (!hooks) return NEXT;
    await this.leased(ctx);
    hooks.revoke(ctx.params.session);
    send(ctx.res, 200, { revoked: true });
  }

  /** Another hooks action reads its body and checks the lease, then falls through. */
  async hooksAction(ctx: RouteContext<'session'>): Promise<Next> {
    if (this.hooksFor(ctx.params.session)) await this.leased(ctx);
    return NEXT;
  }

  /** Any other hooks route is refused outside a desk session, then falls through. */
  hooksOther({ params }: RouteContext<'session'>): Next {
    this.hooksFor(params.session);
    return NEXT;
  }

  localTasks({ res, params }: RouteContext<'session'>): void | Next {
    if (!this.backgroundAllowed(params.session)) return NEXT;
    send(res, 200, { tasks: this.s.localCoding.tasks(params.session) });
  }

  localTask({ res, params }: RouteContext<'session' | 'task'>): void | Next {
    if (!this.backgroundAllowed(params.session)) return NEXT;
    send(res, 200, this.s.localCoding.taskOutput(params.session, params.task));
  }

  stopLocalTask({ res, params }: RouteContext<'session' | 'task'>): void | Next {
    if (!this.backgroundAllowed(params.session)) return NEXT;
    send(res, 200, this.s.localCoding.stopTask(params.session, params.task));
  }

  /** Any other background-command route is refused outside a desk session, then falls through. */
  localTasksOther({ params }: RouteContext<'session'>): Next {
    this.backgroundAllowed(params.session);
    return NEXT;
  }

  async localDiff({ res, params }: RouteContext<'session'>): Promise<void> {
    const id = params.session;
    if (!this.s.store.localWorkspace(id))
      throw new ServiceError('local_denied', 'Local workspace required');
    send(res, 200, { text: await localDiff(this.s.store.session(id).cwd) });
  }

  /** An edit request's exact files, before and after, so an editor can show it as a diff. */
  localEdits({ res, url, params }: RouteContext<'session'>): void {
    const id = params.session;
    if (!this.s.store.localCoding(id))
      throw new ServiceError('local_denied', 'Local coding session required');
    send(
      res,
      200,
      this.s.localCoding.edits(
        id,
        url.searchParams.has('operation_id')
          ? { operation: string(url.searchParams.get('operation_id'), 'operation_id', 128) }
          : { toolCall: string(url.searchParams.get('tool_call'), 'tool_call', 512) },
      ),
    );
  }

  /** Reads the body and checks the session's control lease; returns the body. */
  private async leased({ req, params }: RouteContext<'session'>): Promise<Record<string, unknown>> {
    const body = object(await readJson(req));
    this.s.store.authorizeControl(params.session, controllerOf(body));
    return body;
  }

  /** The supervisor's hooks, if it has any, once the session is shown to be a desk session. */
  private hooksFor(id: string): Supervisor['hooks'] {
    const hooks = this.s.supervisor.hooks;
    if (!hooks) return undefined;
    if (!this.s.supervisor.isInteractiveCoding(id))
      throw new ServiceError('hooks_denied', 'Hooks run only in your own desk sessions', 403);
    return hooks;
  }

  /** Background commands exist with local coding, and only in a desk session. */
  private backgroundAllowed(id: string): boolean {
    if (!this.s.localCoding) return false;
    if (!this.s.supervisor.isInteractiveCoding(id))
      throw new ServiceError('background_denied', 'Background commands are not admitted', 403);
    return true;
  }
}
