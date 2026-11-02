// Requests from delegated children: team messages, specialist repository reads and findings, and
// a parent's own children (spawn, list, inspect, consume, acknowledge).
import { ServiceError, digest, object, string } from '../../core/index.js';
import type { Store } from '../../store/index.js';
import type { ChildWork, RepositorySnapshots } from '../../workers/index.js';
import type { TeamBridge } from '../team.js';
import { unawaited, type BridgeRequest } from './bridge.js';

export interface DelegationDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly team?: TeamBridge;
  readonly repositories?: RepositorySnapshots;
  assertActive(id: string, epoch: number, attempt: string): void;
}

export class DelegationHandlers {
  constructor(private readonly s: DelegationDeps) {}

  /** team.*: a team member sends, receives or acknowledges a message. */
  team({ id, method, body, w }: BridgeRequest): unknown {
    const child = this.s.children?.owned(id);
    if (!child || !this.s.team || !w.attempt) throw new Error('No owned team assignment');
    const binding = this.s.store.workerBoundary.view(child.id).binding;
    if (!binding.assignment || !binding.tools.includes('salaam_team'))
      throw new Error('No team message authority');
    const authorize = () => {
      this.s.assertActive(id, w.epoch, w.attempt!);
      this.s.team!.assert(binding);
      this.s.store.taskGrantCheck?.(id);
    };
    authorize();
    const request = string(body.request_id, 'request_id', 128),
      assignment = binding.assignment.id;
    if (method === 'team.send')
      return unawaited(
        this.s.team.send(
          binding.owner_task!,
          assignment,
          string(body.recipient, 'recipient', 128),
          string(body.text, 'text', 4096),
          request,
          authorize,
        ),
      );
    if (method === 'team.receive')
      return unawaited(this.s.team.receive(assignment, request, authorize));
    if (method === 'team.ack')
      return unawaited(
        this.s.team.acknowledge(
          assignment,
          string(body.message_id, 'message_id', 128),
          request,
          authorize,
        ),
      );
    throw new ServiceError('invalid_field', 'Unknown team method', 400);
  }

  /** specialist.read and specialist.report: a specialist reads its snapshot or reports. */
  specialist({ id, method, body, w }: BridgeRequest): unknown {
    const child = this.s.children?.owned(id);
    if (!child || !this.s.repositories || !w.attempt)
      throw new Error('No active specialist assignment');
    this.s.assertActive(id, w.epoch, w.attempt);
    const binding = this.s.store.workerBoundary.view(child.id).binding;
    const tool = method === 'specialist.read' ? 'salaam_repository' : 'salaam_findings';
    if (!binding.tools.includes(tool)) throw new Error('Specialist authority is unavailable');
    this.s.store.taskGrantCheck?.(id);
    if (method === 'specialist.report') return this.s.repositories.report(binding, body.findings);
    const args = object(body.args);
    return this.s.store.request(
      `specialist-read:${id}:${w.epoch}`,
      string(body.tool_call_id, 'tool_call_id', 512),
      args,
      () => {
        const result = this.s.repositories!.read(binding, args);
        this.s.store.event(id, 'specialist.read', {
          attempt_id: w.attempt,
          snapshot_digest: binding.repository?.digest,
          argument_digest: digest(args),
          result_digest: digest(result),
        });
        return result;
      },
    );
  }

  /** child.*: a parent's own children. */
  child({ id, method, body, w }: BridgeRequest): unknown {
    if (!this.s.children || !w.attempt) throw new Error('No active parent attempt');
    // spawn() resolves a saved step before testing a fresh invocation/grant.
    if (method !== 'child.spawn') this.s.assertActive(id, w.epoch, w.attempt);
    if (method === 'child.spawn') {
      if (
        Object.keys(body).some(
          (key) => !['epoch', 'step_key', 'prompt', 'budget', 'authority', 'profile'].includes(key),
        )
      )
        throw new ServiceError('invalid_child', 'Unsupported child admission field');
      return this.s.children.spawn(
        id,
        w.epoch,
        w.attempt,
        string(body.step_key, 'step_key', 128),
        string(body.prompt, 'prompt', 32768),
        Number(body.budget),
        Array.isArray(body.authority)
          ? body.authority.map((x) => string(x, 'authority', 128))
          : body.profile
            ? []
            : ['salaam_probe'],
        body.profile === undefined ? undefined : string(body.profile, 'profile', 128),
      );
    }
    if (method === 'child.list') return this.s.children.list(id);
    const child = string(body.child_id, 'child_id', 128);
    if (method === 'child.inspect') return this.s.children.inspect(id, child);
    const result = string(body.result_id, 'result_id', 128);
    if (method === 'child.consume') return this.s.children.consume(id, child, result);
    if (method === 'child.ack')
      return this.s.children.acknowledge(
        id,
        child,
        result,
        string(body.request_id, 'request_id', 128),
      );
    throw new Error('Unsupported child operation');
  }
}
