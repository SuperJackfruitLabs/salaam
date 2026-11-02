// Strict AgentPod work on the private owner socket: admitting a card's work, progressing and
// retiring it, its checkpoints, evidence, trace context, board reads and decisions.
import {
  ServiceError,
  agentpodWorkAdmission,
  canonical,
  integer,
  object,
  string,
} from '../core/index.js';
import {
  AgentPodWorkDecisions,
  type AgentPodAuthority,
  type AgentPodWork,
} from '../agentpod/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { RunGrants, TaskDriver, TaskWork } from '../tasks/index.js';
import { authorityRequest } from './control.js';
import { send, type RouteContext } from './router.js';

/** Work input bounds: the instructions and the incoming handoff, and each reference. */
const WORK_TEXT_LIMIT = 65536;
const WORK_REFERENCES_MAX = 64;
const WORK_REFERENCE_LIMIT = 4096;

export interface WorkService {
  readonly agentpod?: AgentPodAuthority;
  readonly agentpodWork?: AgentPodWork;
  readonly agentpodWorkProgression: boolean;
  readonly managed: ManagedWork;
  readonly taskDriver: TaskDriver;
  readonly taskWork: TaskWork;
  /** The one "Approve for this run" grant store, shared by decisions and the station. */
  runGrants(): RunGrants;
}

/** A closed request names exactly these body keys, in any order. */
const keys = (body: Record<string, unknown>): string => Object.keys(body).toSorted().join(',');

export class WorkController {
  constructor(private readonly s: WorkService) {}

  async capability({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (Object.keys(body).length)
      throw new ServiceError('invalid_work_payload', 'Empty capability request required');
    send(res, 200, {
      version: 1,
      enabled: !!this.s.agentpodWork && this.s.agentpodWorkProgression,
    });
  }

  /** Item 11b: restore a checkpoint's files, exactly as approved, for an ended run. */
  async restore({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork) throw new ServiceError('work_disabled', 'Strict work is not enabled');
    if (keys(body) !== 'approved_by,binding,checkpoint_id,request_id,restore_digest')
      throw new ServiceError('invalid_work_payload', 'Closed restore request required');
    const restoreDigest = string(body.restore_digest, 'restore_digest', 64);
    if (!/^[a-f0-9]{64}$/.test(restoreDigest))
      throw new ServiceError('invalid_work_payload', 'A restore names its exact digest');
    send(
      res,
      200,
      await this.s.agentpodWork.restore(
        body.binding,
        string(body.request_id, 'request_id', 128),
        string(body.checkpoint_id, 'checkpoint_id', 128),
        restoreDigest,
        string(body.approved_by, 'approved_by', 128),
      ),
    );
  }

  /** Item 11: read-only checkpoints of the bound run (work-checkpoints) and one checkpoint's diff
   * (work-checkpoint-diff). */
  async checkpoints({ req, res, parts }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork) throw new ServiceError('work_disabled', 'Strict work is not enabled');
    const list = parts[2] === 'work-checkpoints';
    if (keys(body) !== (list ? 'binding' : 'binding,checkpoint_id'))
      throw new ServiceError('invalid_work_payload', 'Closed checkpoint request required');
    send(
      res,
      200,
      list
        ? this.s.agentpodWork.checkpoints(body.binding)
        : await this.s.agentpodWork.checkpointDiff(
            body.binding,
            string(body.checkpoint_id, 'checkpoint_id', 128),
          ),
    );
  }

  /** work-status, or bounded work-progress. */
  async progress({ req, res, parts }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork || !this.s.agentpodWorkProgression)
      throw new ServiceError('work_disabled', 'Strict progression is not enabled');
    if (parts[2] === 'work-status') {
      if (Object.keys(body).join(',') !== 'binding')
        throw new ServiceError('invalid_work_payload', 'Closed status request required');
      send(res, 200, await this.s.agentpodWork.status(body.binding, this.s.taskDriver));
      return;
    }
    if (
      keys(body) !== 'binding,compact,max_steps,request_id,work_request_id' ||
      body.compact !== false
    )
      throw new ServiceError('invalid_work_payload', 'Closed bounded progression request required');
    send(
      res,
      200,
      this.s.agentpodWork.progress(
        body.binding,
        string(body.request_id, 'request_id', 128),
        string(body.work_request_id, 'work_request_id', 128),
        integer(body.max_steps, 'max_steps'),
        this.s.taskDriver,
      ),
    );
  }

  async abandon({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    const work = this.progression('Strict work historical success retirement is not enabled');
    if (keys(body) !== 'binding,producer_terminal_digest,request_id,work_request_id')
      throw new ServiceError('invalid_work_payload', 'Closed explicit failure request required');
    send(
      res,
      200,
      work.abandon(
        body.binding,
        string(body.request_id, 'request_id', 128),
        string(body.work_request_id, 'work_request_id', 128),
        string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
      ),
    );
  }

  async fail({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    const work = this.progression('Strict work failure retirement is not enabled');
    if (keys(body) !== 'binding,producer_terminal_digest,request_id,work_request_id')
      throw new ServiceError('invalid_work_payload', 'Closed explicit failure request required');
    send(
      res,
      200,
      work.fail(
        body.binding,
        string(body.request_id, 'request_id', 128),
        string(body.work_request_id, 'work_request_id', 128),
        string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
        this.s.taskDriver,
      ),
    );
  }

  async expire({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    const work = this.progression('Strict work expiry is not enabled');
    if (
      keys(body) !==
      'binding,decision_request_id,producer_terminal_digest,request_id,work_request_id'
    )
      throw new ServiceError('invalid_work_payload', 'Closed explicit expiry request required');
    send(
      res,
      200,
      work.expire(
        body.binding,
        string(body.request_id, 'request_id', 128),
        string(body.work_request_id, 'work_request_id', 128),
        string(body.decision_request_id, 'decision_request_id', 128),
        string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
        this.s.taskDriver,
      ),
    );
  }

  async settle({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    const work = this.progression('Strict work settlement is not enabled');
    if (keys(body) !== 'binding,producer_terminal_digest,request_id,work_request_id')
      throw new ServiceError('invalid_work_payload', 'Closed explicit settlement request required');
    send(
      res,
      200,
      work.settle(
        body.binding,
        string(body.request_id, 'request_id', 128),
        string(body.work_request_id, 'work_request_id', 128),
        string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
        this.s.taskDriver,
      ),
    );
  }

  async trace({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork) throw new ServiceError('work_disabled', 'Strict work is not enabled');
    if (
      keys(body) !== 'binding,schema_version,traceparent' ||
      body.schema_version !== 'salaam-work-trace/v1'
    )
      throw new ServiceError('invalid_trace_context', 'Closed versioned trace context required');
    send(res, 200, this.s.agentpodWork.trace(body.binding, body.traceparent));
  }

  async evidenceArtifacts({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork) throw new ServiceError('work_disabled', 'Strict work is not enabled');
    if (
      keys(body) !== 'artifact_ids,binding,schema_version' ||
      body.schema_version !== 'salaam-execution-artifacts/v1'
    )
      throw new ServiceError(
        'unsupported_evidence_version',
        'Closed versioned artifact selection required',
      );
    send(res, 200, this.s.agentpodWork.evidenceArtifacts(body.binding, body.artifact_ids));
  }

  async evidence({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork) throw new ServiceError('work_disabled', 'Strict work is not enabled');
    if (
      keys(body) !== 'binding,schema_version' ||
      body.schema_version !== 'salaam-execution-evidence/v1'
    )
      throw new ServiceError(
        'unsupported_evidence_version',
        'Explicit supported evidence version required',
      );
    send(res, 200, this.s.agentpodWork.evidence(body.binding));
  }

  async completion({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork)
      throw new ServiceError(
        'verification_unavailable',
        'Reviewed protected station backend required',
      );
    if (Object.keys(body).join(',') !== 'binding')
      throw new ServiceError('invalid_work_payload', 'Closed completion request required');
    send(res, 200, await this.s.agentpodWork.completion(body.binding));
  }

  async boardRead({ req, res }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork)
      throw new ServiceError('work_disabled', 'Strict progression is not enabled');
    if (keys(body) !== 'answer,binding')
      throw new ServiceError('invalid_board_read', 'Closed board read answer required');
    send(res, 200, this.s.agentpodWork.answerBoardRead(body.binding, body.answer));
  }

  /** work-decisions lists a run's open decisions; work-decision answers one. */
  async decisions({ req, res, parts }: RouteContext): Promise<void> {
    const { body } = await authorityRequest(this.s.agentpod, req);
    if (!this.s.agentpodWork)
      throw new ServiceError(
        'verification_unavailable',
        'Reviewed protected station backend required',
      );
    const answering = parts[2] === 'work-decision';
    if (keys(body) !== (answering ? 'answer,binding' : 'binding'))
      throw new ServiceError('invalid_work_decision', 'Closed decision payload required');
    const decisions = new AgentPodWorkDecisions(
      this.s.agentpodWork,
      this.s.managed,
      this.s.runGrants(),
    );
    send(
      res,
      200,
      answering ? decisions.answer(body.binding, body.answer) : decisions.list(body.binding),
    );
  }

  async admit({ req, res }: RouteContext): Promise<void> {
    const { authority, body } = await authorityRequest(this.s.agentpod, req);
    // This is the private owner socket, never the worker bridge. The native
    // node authenticates its Hub reservation; board/card/stage are that
    // trusted producer's assertion. Runtime pins and byte digests are local.
    if (!this.s.agentpodWork)
      throw new ServiceError(
        'verification_unavailable',
        'Reviewed protected station work backend required',
      );
    if (keys(body) !== 'admission,input,plan')
      throw new ServiceError('invalid_work_payload', 'Closed work payload required');
    const admission = agentpodWorkAdmission(body.admission),
      input = object(body.input);
    if (!closedWorkInput(input))
      throw new ServiceError('invalid_work_payload', 'Closed work input required');
    if (canonical(this.s.taskWork.parse(body.plan)) !== canonical(body.plan))
      throw new ServiceError('invalid_work_payload', 'Fully expanded canonical task plan required');
    const owner = authority.inspect(admission.binding);
    send(
      res,
      200,
      this.s.agentpodWork.admit(
        owner.session_id,
        admission,
        {
          board_id: admission.work.board_id,
          card_id: admission.work.card_id,
          stage_key: admission.work.stage_key,
        },
        input,
        body.plan,
      ),
    );
  }

  /** The routes that retire work need strict progression switched on. */
  private progression(disabled: string): AgentPodWork {
    if (!this.s.agentpodWork || !this.s.agentpodWorkProgression)
      throw new ServiceError('work_disabled', disabled);
    return this.s.agentpodWork;
  }
}

/** Exactly instructions, references and an incoming handoff, each within its bounds. */
function closedWorkInput(input: Record<string, unknown>): boolean {
  return !(
    keys(input) !== 'incoming_handoff,instructions,references' ||
    typeof input.instructions !== 'string' ||
    input.instructions.length < 1 ||
    input.instructions.length > WORK_TEXT_LIMIT ||
    !Array.isArray(input.references) ||
    input.references.length > WORK_REFERENCES_MAX ||
    input.references.some(
      (v) => typeof v !== 'string' || v.length < 1 || v.length > WORK_REFERENCE_LIMIT,
    ) ||
    (input.incoming_handoff !== null &&
      (typeof input.incoming_handoff !== 'string' ||
        input.incoming_handoff.length > WORK_TEXT_LIMIT))
  );
}
