// The service's route tables, in match order. Where patterns overlap, the earlier route wins or
// falls through (NEXT) to the later one, exactly as the one if-chain they replaced did; families
// that never overlap keep that chain's order too, so the table reads the same as the history.
import { CodingController, type CodingService } from './coding.js';
import { ContextController, type ContextService } from './context.js';
import { ControlController, type ControlService } from './control.js';
import { DeskController, type DeskService } from './desk.js';
import {
  IntegrationsController,
  harnessRouteNotFound,
  type IntegrationsService,
} from './integrations.js';
import { JobsController, type JobsService } from './jobs.js';
import { OperationsController, type OperationsService } from './operations.js';
import { RewindController, type RewindService } from './rewind.js';
import { route, type Route } from './router.js';
import { SessionsController, type SessionsService } from './sessions.js';
import { SubmissionsController, type SubmissionsService } from './submissions.js';
import { SystemController, type SystemService } from './system.js';
import { TasksController, type TasksService } from './tasks.js';
import { WorkController, type WorkService } from './work.js';

/** Everything the controllers use; the service passes itself. */
export type RouteService = SystemService &
  IntegrationsService &
  ControlService &
  WorkService &
  JobsService &
  TasksService &
  SessionsService &
  ContextService &
  DeskService &
  RewindService &
  CodingService &
  SubmissionsService &
  OperationsService;

export interface Controllers {
  system: SystemController;
  integrations: IntegrationsController;
  control: ControlController;
  work: WorkController;
  jobs: JobsController;
  tasks: TasksController;
  sessions: SessionsController;
  context: ContextController;
  desk: DeskController;
  rewind: RewindController;
  coding: CodingController;
  submissions: SubmissionsController;
  operations: OperationsController;
}

export function controllers(s: RouteService): Controllers {
  return {
    system: new SystemController(s),
    integrations: new IntegrationsController(s),
    control: new ControlController(s),
    work: new WorkController(s),
    jobs: new JobsController(s),
    tasks: new TasksController(s),
    sessions: new SessionsController(s),
    context: new ContextController(s),
    desk: new DeskController(s),
    rewind: new RewindController(s),
    coding: new CodingController(s),
    submissions: new SubmissionsController(s),
    operations: new OperationsController(s),
  };
}

/** The worker bridge socket answers one route. */
export const BRIDGE_NOT_FOUND = 'Bridge route not found';
export function bridgeRoutes({ system }: Controllers): Route[] {
  return [route('POST', '/worker/:worker/:method', (c) => system.bridge(c))];
}

export const OPERATOR_NOT_FOUND = 'Route not implemented';
export function operatorRoutes(c: Controllers): Route[] {
  return [
    ...integrationRoutes(c),
    ...agentpodRoutes(c),
    ...jobRoutes(c),
    ...workerRoutes(c),
    ...taskRoutes(c),
    ...serviceRoutes(c),
    ...deskRoutes(c),
    ...operationRoutes(c),
    ...sessionRoutes(c),
  ];
}

function integrationRoutes({ integrations: i }: Controllers): Route[] {
  return [
    route('POST', 'url:/managed-toolkit/v1/verify', (c) => i.toolkitVerify(c)),
    route('POST', 'url:/managed-toolkit/v1/control', (c) => i.toolkitControl(c)),
    route('GET', '/v1/a2a/grants/:assignment', (c) => i.a2aGrant(c)),
    route('GET', '/v1/harnesses', (c) => i.harnesses(c)),
    route('GET', '/v1/harnesses/:worker', (c) => i.harness(c)),
    route('POST', '/v1/harnesses/:worker/reconcile', (c) => i.reconcileHarness(c)),
    route('*', '/v1/harnesses/:worker/**', (c) => i.unknownHarnessRoute(c)),
    route('*', '/v1/harnesses/**', () => harnessRouteNotFound()),
  ];
}

function agentpodRoutes({ control, work }: Controllers): Route[] {
  return [
    route('POST', '/v1/agentpod/attach', (c) => control.attach(c)),
    route('POST', '/v1/agentpod/status', (c) => control.status(c)),
    route('POST', '/v1/agentpod/work-capability', (c) => work.capability(c)),
    route('POST', '/v1/agentpod/work-restore', (c) => work.restore(c)),
    route('POST', '/v1/agentpod/work-checkpoints', (c) => work.checkpoints(c)),
    route('POST', '/v1/agentpod/work-checkpoint-diff', (c) => work.checkpoints(c)),
    route('POST', '/v1/agentpod/work-status', (c) => work.progress(c)),
    route('POST', '/v1/agentpod/work-progress', (c) => work.progress(c)),
    route('POST', '/v1/agentpod/work-abandon', (c) => work.abandon(c)),
    route('POST', '/v1/agentpod/work-fail', (c) => work.fail(c)),
    route('POST', '/v1/agentpod/work-expire', (c) => work.expire(c)),
    route('POST', '/v1/agentpod/work-settle', (c) => work.settle(c)),
    route('POST', '/v1/agentpod/work-trace', (c) => work.trace(c)),
    route('POST', '/v1/agentpod/work-evidence-artifacts', (c) => work.evidenceArtifacts(c)),
    route('POST', '/v1/agentpod/work-evidence', (c) => work.evidence(c)),
    route('POST', '/v1/agentpod/work-completion', (c) => work.completion(c)),
    route('POST', '/v1/agentpod/work-read', (c) => work.boardRead(c)),
    route('POST', '/v1/agentpod/work-decisions', (c) => work.decisions(c)),
    route('POST', '/v1/agentpod/work-decision', (c) => work.decisions(c)),
    route('POST', '/v1/agentpod/work-admit', (c) => work.admit(c)),
    route('POST', '/v1/agentpod/mcp-assign', (c) => control.assignMcp(c)),
    route('POST', '/v1/agentpod/admit', (c) => control.admit(c)),
    route('POST', '/v1/agentpod/renew', (c) => control.renew(c)),
    route('POST', '/v1/agentpod/revoke', (c) => control.revokeAdmission(c)),
    route('POST', '/v1/agentpod/:method', (c) => control.unknownAuthorityMethod(c)),
  ];
}

function jobRoutes({ jobs }: Controllers): Route[] {
  return [
    route('GET', '/v1/job-occurrences/:occurrence', (c) => jobs.occurrence(c)),
    route('GET', '/v1/inbox', (c) => jobs.inboxList(c)),
    route('GET', '/v1/inbox/:item/**', (c) => jobs.inboxItem(c)),
    route('POST', '/v1/inbox/:item/ack', (c) => jobs.inboxAck(c)),
    route('*', '/v1/inbox/**', () => jobs.inboxNotFound()),
    route('GET', '/v1/schedules', (c) => jobs.schedules(c)),
    route('GET', '/v1/schedules/:schedule/occurrences/**', (c) => jobs.scheduleOccurrences(c)),
    route('GET', '/v1/schedules/:schedule/**', (c) => jobs.schedule(c)),
    route('POST', '/v1/schedules', (c) => jobs.changeSchedule(c)),
    route('POST', '/v1/schedules/:schedule/update', (c) => jobs.changeSchedule(c)),
    route('POST', '/v1/schedules/:schedule/run', (c) => jobs.changeSchedule(c)),
    route('*', '/v1/schedules/**', (c) => jobs.scheduleNotFound(c)),
    route('GET', '/v1/jobs', (c) => jobs.jobList(c)),
    route('GET', '/v1/jobs/:job', (c) => jobs.job(c)),
    route('POST', '/v1/jobs', (c) => jobs.changeJob(c)),
    route('POST', '/v1/jobs/:job/run', (c) => jobs.changeJob(c)),
    route('POST', '/v1/jobs/:job/cancel', (c) => jobs.changeJob(c)),
    route('*', '/v1/jobs/**', () => jobs.jobNotFound()),
  ];
}

function workerRoutes({ integrations: i }: Controllers): Route[] {
  return [
    route('POST', '/v1/integrations/:worker/resolve', (c) => i.resolveIntegration(c)),
    route('GET', '/v1/integrations/:worker', (c) => i.integration(c)),
    route('GET', '/v1/workers/:worker/proposal', (c) => i.proposal(c)),
    route('POST', '/v1/workers/:worker/integrate', (c) => i.integrate(c)),
    route('*', '/v1/workers/:worker/:action', (c) => i.workerAction(c)),
  ];
}

function taskRoutes({ tasks: t }: Controllers): Route[] {
  return [
    route('GET', '/v1/tasks/:task/team', (c) => t.team(c)),
    route('POST', '/v1/tasks/:task/team/assign', (c) => t.assign(c)),
    route('POST', '/v1/tasks/:task/team/send', (c) => t.sendMessage(c)),
    route('POST', '/v1/tasks/:task/team/:assignment/run', (c) => t.assignment(c)),
    route('POST', '/v1/tasks/:task/team/:assignment/reject', (c) => t.assignment(c)),
    route('POST', '/v1/tasks/:task/team/:assignment/receive', (c) => t.assignment(c)),
    route('POST', '/v1/tasks/:task/team/:assignment/ack', (c) => t.assignment(c)),
    route('POST', '/v1/tasks/:task/team/:assignment/:action', (c) => t.assignment(c)),
    route('POST', '/v1/tasks/:task/team/**', (c) => t.unknownTeamPost(c)),
    route('*', '/v1/tasks/:task/team/**', (c) => t.unknownTeamRoute(c)),
    route('GET', '/v1/tasks', (c) => t.current(c)),
    route('GET', '/v1/tasks/:task/checkpoints', (c) => t.checkpoints(c)),
    route('GET', '/v1/tasks/:task/restores', (c) => t.checkpoints(c)),
    route('GET', '/v1/tasks/:task', (c) => t.view(c)),
    route('GET', '/v1/tasks/:task/history', (c) => t.history(c)),
    route('POST', '/v1/tasks', (c) => t.create(c)),
    route('POST', '/v1/tasks/:task/verify', (c) => t.act(c)),
    route('POST', '/v1/tasks/:task/finish', (c) => t.act(c)),
    route('POST', '/v1/tasks/:task/checkpoint', (c) => t.act(c)),
    route('POST', '/v1/tasks/:task/restore', (c) => t.act(c)),
    route('POST', '/v1/tasks/:task/auto', (c) => t.act(c)),
    route('POST', '/v1/tasks/:task/cancel', (c) => t.act(c)),
    route('POST', '/v1/tasks/:task/revise', (c) => t.revise(c)),
    route('POST', '/v1/tasks/:task/steps/:step/run', (c) => t.runStep(c)),
    route('POST', '/v1/tasks/:task/steps/:step/complete', (c) => t.completeStep(c)),
    route('POST', '/v1/tasks/**', (c) => t.otherPost(c)),
  ];
}

function serviceRoutes({ system, sessions }: Controllers): Route[] {
  return [
    route('GET', 'path:/v1/command-inventory', (c) => system.commandInventory(c)),
    route('GET', 'path:/v1/health', (c) => system.health(c)),
    route('POST', 'path:/v1/shutdown', (c) => system.shutdown(c)),
    route('GET', 'path:/v1/sessions', (c) => sessions.list(c)),
    route('POST', 'path:/v1/sessions', (c) => sessions.create(c)),
    route('GET', '/v1/compactions/:compaction', (c) => sessions.compaction(c)),
    route('POST', '/v1/compactions/:compaction/cancel/**', (c) => sessions.cancelCompaction(c)),
    route('*', '/v1/compactions/:compaction/**', (c) => sessions.compactionRoute(c)),
  ];
}

/** The first run of /v1/sessions/:session routes. */
function deskRoutes(c: Controllers): Route[] {
  const { desk, rewind, sessions, control, context, coding, submissions } = c;
  const s = '/v1/sessions/:session';
  return [
    route('GET', `${s}/approval-rules`, (x) => desk.approvalRules(x)),
    route('POST', `${s}/approval-rules`, (x) => desk.addApprovalRule(x)),
    route('POST', `${s}/approval-rules/:rule/remove`, (x) => desk.removeApprovalRule(x)),
    route('*', `${s}/approval-rules`, (x) => desk.approvalRulesOther(x)),
    route('*', `${s}/approval-rules/:rule/:action`, (x) => desk.approvalRulesOther(x)),
    route('GET', `${s}/permissions`, (x) => desk.permissions(x)),
    route('POST', `${s}/permissions`, (x) => desk.configurePermissions(x)),
    route('GET', `${s}/danger-classifier`, (x) => desk.reviewer(x)),
    route('POST', `${s}/danger-classifier`, (x) => desk.chooseReviewer(x)),
    route('GET', `${s}/hooks`, (x) => desk.hooks(x)),
    route('POST', `${s}/hooks/trust`, (x) => desk.trustHooks(x)),
    route('POST', `${s}/hooks/revoke`, (x) => desk.revokeHooks(x)),
    route('POST', `${s}/hooks/:action`, (x) => desk.hooksAction(x)),
    route('*', `${s}/hooks/**`, (x) => desk.hooksOther(x)),
    route('GET', `${s}/local-tasks`, (x) => desk.localTasks(x)),
    route('GET', `${s}/local-tasks/:task`, (x) => desk.localTask(x)),
    route('POST', `${s}/local-tasks/:task/stop`, (x) => desk.stopLocalTask(x)),
    route('*', `${s}/local-tasks/**`, (x) => desk.localTasksOther(x)),
    route('GET', `${s}/local-diff`, (x) => desk.localDiff(x)),
    route('GET', `${s}/local-edits`, (x) => desk.localEdits(x)),
    route('POST', `${s}/steer`, (x) => submissions.steer(x)),
    route('POST', `${s}/undo-reconcile`, (x) => rewind.reconcileUndo(x)),
    route('GET', `${s}/undo`, (x) => rewind.undo(x)),
    route('POST', `${s}/undo`, (x) => rewind.applyUndo(x)),
    route('GET', `${s}/checkpoints`, (x) => rewind.checkpoints(x)),
    route('GET', `${s}/rewind`, (x) => rewind.reviewRewind(x)),
    route('POST', `${s}/rewind`, (x) => rewind.rewind(x)),
    route('GET', `${s}/review`, (x) => rewind.review(x)),
    route('GET', `${s}/review/hunks`, (x) => rewind.hunks(x)),
    route('POST', `${s}/review`, (x) => rewind.act(x)),
    route('POST', `${s}/fork`, (x) => sessions.fork(x)),
    route('GET', `${s}/name`, (x) => sessions.name(x)),
    route('POST', `${s}/name`, (x) => sessions.rename(x)),
    route('GET', `${s}/revocation`, (x) => control.revocation(x)),
    route('POST', `${s}/revoke`, (x) => control.revoke(x)),
    route('GET', `${s}/agents/**`, (x) => context.agents(x)),
    route('*', `${s}/agents/admit/**`, (x) => context.admitAgent(x)),
    route('*', `${s}/agents/revoke/**`, (x) => context.revokeAgent(x)),
    route('*', `${s}/agents/**`, (x) => context.unknownAgentOperation(x)),
    route('GET', `${s}/activity/**`, (x) => sessions.activity(x)),
    route('GET', `${s}/workspace/diff/**`, (x) => coding.workspaceDiff(x)),
    route('GET', `${s}/workspace/**`, (x) => coding.workspace(x)),
    route('POST', `${s}/workspace/refresh/**`, (x) => coding.refreshWorkspace(x)),
    route('GET', `${s}/commands`, (x) => coding.commands(x)),
    route('GET', `${s}/commands/:command/logs/**`, (x) => coding.commandLogs(x)),
    route('GET', `${s}/commands/:command/**`, (x) => coding.command(x)),
    route('POST', `${s}/commands`, (x) => coding.start(x)),
    route('POST', `${s}/commands/:command/cancel/**`, (x) => coding.cancel(x)),
    route('POST', `${s}/commands/:command/reconcile/**`, (x) => coding.reconcile(x)),
    route('POST', `${s}/commands/**`, (x) => coding.other(x)),
    route('GET', `${s}/context`, (x) => context.context(x)),
    route('POST', `${s}/context/plan/**`, (x) => context.admitContext(x)),
    route('POST', `${s}/context/admit/**`, (x) => context.admitContext(x)),
    route('GET', `${s}/task/**`, (x) => context.task(x)),
    route('GET', `${s}/history/**`, (x) => context.history(x)),
    route('POST', `${s}/task/**`, (x) => context.change(x)),
    route('POST', `${s}/compact/**`, (x) => context.change(x)),
    route('POST', `${s}/artifacts/**`, (x) => context.change(x)),
  ];
}

function operationRoutes({ operations: o, submissions, tasks }: Controllers): Route[] {
  return [
    route('GET', '/v1/approvals', (c) => o.approvals(c)),
    route('GET', '/v1/approvals/:approval', (c) => o.approval(c)),
    route('POST', '/v1/approvals/:approval/decision/**', (c) => o.decide(c)),
    route('GET', '/v1/toolkit/calls/:call', (c) => o.toolkitCall(c)),
    route('POST', '/v1/toolkit/calls/:call/resolution', (c) => o.resolveToolkitCall(c)),
    route('GET', '/v1/operations/:operation', (c) => o.operation(c)),
    route('POST', '/v1/operations/:operation/reconcile/**', (c) => o.reconcile(c)),
    route('POST', '/v1/operations/:operation/resolution/**', (c) => o.resolve(c)),
    route('GET', '/v1/station/calls/:call', (c) => o.stationCall(c)),
    route('GET', '/v1/attempts/:attempt', (c) => submissions.attempt(c)),
    route('POST', '/v1/attempts/:attempt/cancel/**', (c) => submissions.cancelAttempt(c)),
    route('GET', '/v1/children/:child', (c) => tasks.child(c)),
    route('GET', '/v1/children/:child/result/**', (c) => tasks.childResult(c)),
    route('POST', '/v1/children/:child/ack/**', (c) => tasks.acknowledgeChild(c)),
    route('*', '/v1/children/:child/**', (c) => tasks.childRoute(c)),
  ];
}

/** The second run of /v1/sessions/:session routes. */
function sessionRoutes({ sessions, submissions, control }: Controllers): Route[] {
  const s = '/v1/sessions/:session';
  return [
    route('GET', `${s}/children/**`, (x) => sessions.children(x)),
    route('GET', `${s}/usage/**`, (x) => sessions.usage(x)),
    route('GET', s, (x) => sessions.view(x)),
    route('GET', `${s}/snapshot/**`, (x) => sessions.snapshot(x)),
    route('GET', `${s}/tool-metadata/**`, (x) => sessions.toolMetadata(x)),
    route('GET', `${s}/cancellations/**`, (x) => submissions.cancellations(x)),
    route('POST', `${s}/cancellations/**`, (x) => submissions.cancelTurn(x)),
    route('POST', `${s}/control/**`, (x) => control.control(x)),
    route('POST', `${s}/route/**`, (x) => sessions.switchRoute(x)),
    route('POST', `${s}/resume/**`, (x) => sessions.resume(x)),
    route('GET', `${s}/events/**`, (x) => submissions.events(x)),
    route('POST', `${s}/submissions/**`, (x) => submissions.submit(x)),
    route('POST', `${s}/probe/**`, (x) => submissions.probe(x)),
  ];
}
