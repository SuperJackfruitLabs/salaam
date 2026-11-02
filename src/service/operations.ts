// Managed operations and their approvals: deciding an approval, reconciling an operation whose
// outcome is unknown, and an operator's resolution of an operation or a Toolkit call.
import { ServiceError, integer, object, readJson, string } from '../core/index.js';
import type { StationWork } from '../agentpod/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { Store } from '../store/index.js';
import type { ToolkitResolutions } from '../toolkit/index.js';
import { send, type RouteContext } from './router.js';

export interface OperationsService {
  readonly store: Store;
  readonly managed: ManagedWork;
  readonly toolkitResolutions: ToolkitResolutions;
  readonly station?: StationWork;
}

/** The most characters of an operator's evidence for a resolution. */
const EVIDENCE_LIMIT = 4096;

/** An operator's resolution names one of the two definite outcomes. */
function outcomeOf(body: Record<string, unknown>): 'succeeded' | 'failed_definite' {
  const outcome = string(body.outcome, 'outcome');
  if (outcome !== 'succeeded' && outcome !== 'failed_definite')
    throw new ServiceError('invalid_field', 'Invalid resolution outcome', 400);
  return outcome;
}

export class OperationsController {
  constructor(private readonly s: OperationsService) {}

  approvals({ res, url }: RouteContext): void {
    const id = url.searchParams.get('session');
    this.s.managed.expire();
    send(res, 200, id ? this.s.store.approvals(id) : this.s.managed.pending());
  }

  approval({ res, params }: RouteContext<'approval'>): void {
    this.s.managed.expire();
    send(res, 200, this.s.managed.approval(params.approval));
  }

  async decide({ req, res, params }: RouteContext<'approval'>): Promise<void> {
    const body = object(await readJson(req));
    const decision = string(body.decision, 'decision');
    if (decision !== 'approve' && decision !== 'deny')
      throw new ServiceError('invalid_field', 'Decision must be approve or deny', 400);
    send(
      res,
      200,
      this.s.managed.decide(
        params.approval,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        string(body.operation_digest, 'operation_digest', 128),
        decision,
      ),
    );
  }

  toolkitCall({ res, params }: RouteContext<'call'>): void {
    send(res, 200, this.s.toolkitResolutions.inspect(params.call));
  }

  async resolveToolkitCall({ req, res, params }: RouteContext<'call'>): Promise<void> {
    const body = object(await readJson(req)),
      outcome = outcomeOf(body);
    send(
      res,
      200,
      await this.s.toolkitResolutions.resolveRead(
        params.call,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        string(body.context_digest, 'context_digest', 128),
        outcome,
        string(body.evidence, 'evidence', EVIDENCE_LIMIT),
      ),
    );
  }

  operation({ res, params }: RouteContext<'operation'>): void {
    send(res, 200, this.s.managed.operation(params.operation));
  }

  /** Reconcile once per request ID: a repeated request gets the saved answer. */
  async reconcile({ req, res, params }: RouteContext<'operation'>): Promise<void> {
    const id = params.operation;
    const body = object(await readJson(req));
    const request = string(body.request_id, 'request_id', 128);
    const input = { kind: 'reconcile-operation', id };
    const saved = this.s.store.cachedRequest('local-operator', request, input);
    if (saved !== undefined) {
      send(res, 200, saved);
      return;
    }
    const result = await this.s.managed.reconcile(id);
    send(
      res,
      200,
      this.s.store.request('local-operator', request, input, () => result),
    );
  }

  async resolve({ req, res, params }: RouteContext<'operation'>): Promise<void> {
    const id = params.operation;
    const body = object(await readJson(req));
    const outcome = outcomeOf(body);
    const resolutions = this.s.toolkitResolutions;
    send(
      res,
      200,
      await (
        resolutions.owns(id)
          ? resolutions.resolveOperation.bind(resolutions)
          : this.s.managed.resolve.bind(this.s.managed)
      )(
        id,
        string(body.request_id, 'request_id', 128),
        integer(body.expected_revision, 'expected_revision'),
        string(body.operation_digest, 'operation_digest', 128),
        outcome,
        string(body.evidence, 'evidence', EVIDENCE_LIMIT),
      ),
    );
  }

  stationCall({ res, params }: RouteContext<'call'>): void {
    if (!this.s.station)
      throw new ServiceError('station_disabled', 'Station execution is unavailable');
    send(res, 200, this.s.station.view(params.call));
  }
}
