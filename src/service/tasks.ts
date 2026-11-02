// Durable tasks: plans, steps, verification and checkpoints; their team of worker assignments;
// and the child sessions a parent consumes results from.
import type { IncomingMessage } from 'node:http';
import { ServiceError, integer, object, readJson, string } from '../core/index.js';
import type { Store } from '../store/index.js';
import type {
  TaskCheckpoints,
  TaskDriver,
  TaskVerification,
  TaskWork,
  TeamWork,
} from '../tasks/index.js';
import type { ChildWork } from '../workers/index.js';
import { send, NEXT, type Next, type RouteContext } from './router.js';

export interface TasksService {
  readonly store: Store;
  readonly taskWork: TaskWork;
  readonly taskDriver: TaskDriver;
  readonly taskVerification: TaskVerification;
  readonly taskCheckpoints: TaskCheckpoints;
  readonly team: TeamWork;
  readonly children: ChildWork;
}

interface Controller {
  client_id: string;
  token: string;
}

const controllerOf = (body: Record<string, unknown>): Controller => ({
  client_id: string(body.client_id, 'client_id', 128),
  token: string(body.token, 'token', 128),
});

export class TasksController {
  constructor(private readonly s: TasksService) {}

  team({ res, params }: RouteContext<'task'>): void {
    const task = this.s.taskWork.get(params.task);
    send(res, 200, this.s.team.view(task.id));
  }

  async assign(ctx: RouteContext<'task'>): Promise<void> {
    const { task, body, request, controller } = await this.teamRequest(ctx);
    if (body.runtime !== undefined && body.requests !== undefined)
      throw new ServiceError(
        'worker_budget_scope',
        'Use invocations for an external runtime; requests always means model requests',
        400,
      );
    send(
      ctx.res,
      200,
      this.s.team.assign(
        task.id,
        string(body.step_id, 'step_id', 128),
        string(body.profile_id, 'profile_id', 128),
        integer(
          body.runtime === undefined ? body.requests : body.invocations,
          body.runtime === undefined ? 'requests' : 'invocations',
        ),
        request,
        integer(body.expected_revision, 'expected_revision'),
        controller,
        body.runtime === undefined ? undefined : string(body.runtime, 'runtime', 128),
      ),
    );
  }

  async sendMessage(ctx: RouteContext<'task'>): Promise<void> {
    const { task, body, request, authorize } = await this.teamRequest(ctx);
    send(
      ctx.res,
      200,
      this.s.team.send(
        task.id,
        'operator',
        string(body.recipient, 'recipient', 128),
        string(body.text, 'text', 4096),
        request,
        authorize,
      ),
    );
  }

  /** One assignment's run, reject, receive or ack. */
  async assignment(ctx: RouteContext<'task' | 'assignment'>): Promise<void> {
    const { task, body, request, controller, authorize } = await this.teamRequest(ctx);
    const assignment = this.s.team.get(ctx.params.assignment);
    if (assignment.task_id !== task.id)
      throw new ServiceError('team_message_scope', 'Assignment belongs to another task');
    let result: unknown;
    const action = ctx.parts[5];
    if (action === 'run')
      result = this.s.team.run(
        assignment.id,
        request,
        integer(body.expected_revision, 'expected_revision'),
        integer(body.generation, 'generation'),
        body.instruction == null ? null : string(body.instruction, 'instruction', 4096),
        body.continues_attempt_id == null
          ? null
          : string(body.continues_attempt_id, 'continues_attempt_id', 128),
        controller,
      );
    else if (action === 'reject')
      result = this.s.team.reject(
        assignment.id,
        request,
        integer(body.expected_revision, 'expected_revision'),
        integer(body.generation, 'generation'),
        string(body.reason, 'reason', 4096),
        controller,
      );
    else if (action === 'receive') result = this.s.team.receive(assignment.id, request, authorize);
    else if (action === 'ack')
      result = this.s.team.acknowledge(
        assignment.id,
        string(body.message_id, 'message_id', 128),
        request,
        authorize,
      );
    else throw new ServiceError('not_found', 'Team action not found', 404);
    send(ctx.res, 200, result);
  }

  async unknownTeamPost(ctx: RouteContext<'task'>): Promise<never> {
    await this.teamRequest(ctx);
    throw teamRouteNotFound();
  }

  unknownTeamRoute({ params }: RouteContext<'task'>): never {
    this.s.taskWork.get(params.task);
    throw teamRouteNotFound();
  }

  async current({ res, url }: RouteContext): Promise<void> {
    const session = string(url.searchParams.get('session_id'), 'session_id', 128);
    this.s.store.session(session);
    const current = this.s.taskWork.forSession(session);
    send(res, 200, current ? await this.s.taskDriver.viewAsync(current.id) : null);
  }

  /** A task's checkpoints, or the restores made from them. */
  checkpoints({ res, parts, params }: RouteContext<'task'>): void {
    this.s.taskWork.get(params.task);
    send(
      res,
      200,
      parts[3] === 'checkpoints'
        ? this.s.taskCheckpoints.list(params.task)
        : this.s.taskCheckpoints.restores(params.task),
    );
  }

  async view({ res, params }: RouteContext<'task'>): Promise<void> {
    send(res, 200, await this.s.taskDriver.viewAsync(params.task));
  }

  history({ res, url, params }: RouteContext<'task'>): void {
    send(
      res,
      200,
      this.s.taskWork.history(
        params.task,
        integer(Number(url.searchParams.get('offset') ?? '0'), 'offset'),
      ),
    );
  }

  async create(ctx: RouteContext): Promise<void> {
    const { body, controller, request, expected } = await taskRequest(ctx.req);
    const task = this.s.taskWork.create(
      string(body.session_id, 'session_id', 128),
      request,
      expected,
      body.plan,
      controller,
    );
    send(ctx.res, 201, await this.s.taskDriver.viewAsync(task.id));
  }

  /** verify, finish, checkpoint, restore, auto or cancel. */
  async act(ctx: RouteContext<'task'>): Promise<void> {
    const { body, controller, request, expected } = await taskRequest(ctx.req);
    const taskId = ctx.params.task;
    const task = this.s.taskWork.get(taskId),
      authorize = () => this.s.store.authorizeControl(task.session_id, controller);
    let result: unknown;
    const action = ctx.parts[3];
    if (action === 'verify')
      result = this.s.taskVerification.start(
        taskId,
        string(body.check_key, 'check_key', 64),
        body.step_id == null ? null : string(body.step_id, 'step_id', 128),
        request,
        expected,
        authorize,
      );
    else if (action === 'finish') {
      const exception = body.exception == null ? null : object(body.exception);
      await this.s.taskVerification.finishAsync(
        taskId,
        request,
        expected,
        exception
          ? {
              reason: string(exception.reason, 'reason', 4096),
              evidence_artifact: string(exception.evidence_artifact, 'evidence_artifact', 128),
            }
          : null,
        authorize,
      );
      result = await this.s.taskDriver.viewAsync(taskId);
    } else if (action === 'checkpoint')
      result = this.s.taskCheckpoints.capture(taskId, request, expected, authorize);
    else if (action === 'restore')
      result = this.s.taskCheckpoints.restore(
        taskId,
        string(body.checkpoint_id, 'checkpoint_id', 128),
        request,
        expected,
        integer(body.workspace_revision, 'workspace_revision'),
        string(body.workspace_digest, 'workspace_digest', 128),
        authorize,
      );
    else if (action === 'auto') {
      if (body.compact !== undefined && typeof body.compact !== 'boolean')
        throw new ServiceError('invalid_field', 'compact must be boolean', 400);
      this.s.taskDriver.configure(
        taskId,
        request,
        expected,
        integer(body.max_steps, 'max_steps'),
        body.compact === true,
        controller,
      );
      result = await this.s.taskDriver.viewAsync(taskId);
    } else {
      await this.s.taskDriver.cancel(taskId, request, expected, controller);
      result = await this.s.taskDriver.viewAsync(taskId);
    }
    send(ctx.res, 200, result);
  }

  async revise(ctx: RouteContext<'task'>): Promise<void> {
    const { body, controller, request, expected } = await taskRequest(ctx.req);
    const taskId = ctx.params.task;
    send(
      ctx.res,
      200,
      (this.s.taskWork.revise(taskId, request, expected, body.plan, controller),
      await this.s.taskDriver.viewAsync(taskId)),
    );
  }

  async runStep(ctx: RouteContext<'task' | 'step'>): Promise<void> {
    const { body, controller, request, expected } = await taskRequest(ctx.req);
    send(
      ctx.res,
      202,
      this.s.taskWork.run(
        ctx.params.task,
        ctx.params.step,
        request,
        expected,
        body.instruction == null ? null : string(body.instruction, 'instruction', 4096),
        body.continues_attempt_id == null
          ? null
          : string(body.continues_attempt_id, 'continues_attempt_id', 128),
        controller,
      ),
    );
  }

  async completeStep(ctx: RouteContext<'task' | 'step'>): Promise<void> {
    const { body, controller, request, expected } = await taskRequest(ctx.req);
    const taskId = ctx.params.task;
    send(
      ctx.res,
      200,
      (this.s.taskWork.complete(
        taskId,
        ctx.params.step,
        request,
        expected,
        string(body.review, 'review', 4096),
        controller,
      ),
      await this.s.taskDriver.viewAsync(taskId)),
    );
  }

  /** Any other POST under /v1/tasks reads and checks its body, then falls through. */
  async otherPost({ req }: RouteContext): Promise<Next> {
    await taskRequest(req);
    return NEXT;
  }

  child({ res, params }: RouteContext<'child'>): void {
    const child = this.childOf(params.child);
    send(res, 200, this.s.children.inspect(child.parent_session, params.child));
  }

  childResult({ res, params }: RouteContext<'child'>): void {
    const child = this.childOf(params.child);
    const row = this.s.children.inspect(child.parent_session, params.child);
    send(res, 200, this.s.children.consume(child.parent_session, row.id, row.result_id ?? ''));
  }

  async acknowledgeChild({ req, res, params }: RouteContext<'child'>): Promise<void> {
    const child = this.childOf(params.child);
    const body = object(await readJson(req));
    send(
      res,
      200,
      this.s.children.acknowledge(
        child.parent_session,
        params.child,
        string(body.result_id, 'result_id', 128),
        string(body.request_id, 'request_id', 128),
      ),
    );
  }

  /** Any other route under a child: an unknown child is not found; a known one falls through. */
  childRoute({ params }: RouteContext<'child'>): Next {
    this.childOf(params.child);
    return NEXT;
  }

  /** A team POST reads the task, its body, request ID and controller lease, in that order. */
  private async teamRequest({ req, params }: RouteContext<'task'>) {
    const task = this.s.taskWork.get(params.task);
    const body = object(await readJson(req));
    const request = string(body.request_id, 'request_id', 128);
    const controller = controllerOf(body);
    const authorize = () => this.s.store.authorizeControl(task.session_id, controller);
    return { task, body, request, controller, authorize };
  }

  private childOf(id: string): { parent_session: string } {
    const child = this.s.store.db
      .prepare('SELECT parent_session FROM child_tasks WHERE id=?')
      .get(id) as { parent_session: string } | undefined;
    if (!child) throw new ServiceError('not_found', 'Child not found', 404);
    return child;
  }
}

/** Every task POST reads its body, controller lease, request ID and expected revision first. */
async function taskRequest(req: IncomingMessage) {
  const body = object(await readJson(req));
  const controller = controllerOf(body);
  const request = string(body.request_id, 'request_id', 128);
  const expected = integer(body.expected_revision, 'expected_revision');
  return { body, controller, request, expected };
}

function teamRouteNotFound(): ServiceError {
  return new ServiceError('not_found', 'Team route not found', 404);
}
