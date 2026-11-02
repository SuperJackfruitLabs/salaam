// Requests to do work in an owned coding workspace (guarded files, isolated commands) and managed
// operations a person approves (review and effect).
import { ServiceError, object, string, type CodingBinding } from '../../core/index.js';
import type { Store } from '../../store/index.js';
import type { ManagedWork } from '../../execution/index.js';
import type { CodingWork } from '../../coding/index.js';
import { repositoryPath, type ChildWork } from '../../workers/index.js';
import type { BridgeRequest } from './bridge.js';

export interface WorkDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly coding?: CodingWork;
  readonly managed?: ManagedWork;
  readonly options: { readonly effectsEnabled?: boolean };
  codingBinding(id: string): CodingBinding | undefined;
  assertActive(id: string, epoch: number, attempt: string): void;
}

export class WorkHandlers {
  constructor(private readonly s: WorkDeps) {}

  /** coding.files and coding.command: the owned coding workspace. */
  coding({ id, method, body, w }: BridgeRequest): unknown {
    if (!this.s.coding || !this.s.codingBinding(id) || !w.attempt)
      throw new Error('Coding authority is unavailable');
    this.s.assertActive(id, w.epoch, w.attempt);
    this.s.store.taskGrantCheck?.(id);
    const args = object(body.args);
    if (method === 'coding.files') {
      if (!this.s.codingBinding(id)?.files) throw new Error('File authority is unavailable');
      if (this.s.children?.owned(id) && args.path !== undefined) repositoryPath(args.path);
      return this.s.coding.file(
        id,
        w.epoch,
        w.attempt,
        string(body.tool_call_id, 'tool_call_id', 512),
        args,
      );
    }
    if (!this.s.codingBinding(id)?.commands) throw new Error('Command execution is unavailable');
    if (args.action === 'start')
      return this.s.coding.start(id, w.attempt, args, () =>
        this.s.assertActive(id, w.epoch, w.attempt!),
      );
    const run = string(args.run_id, 'run_id', 128);
    if (args.action === 'status') return this.s.coding.get(id, run);
    if (args.action === 'logs') return this.s.coding.logs(id, run, Number(args.offset ?? 0));
    if (args.action === 'cancel')
      return this.s.coding.cancel(id, run, string(body.tool_call_id, 'tool_call_id', 512), () =>
        this.s.assertActive(id, w.epoch, w.attempt!),
      );
    throw new ServiceError('invalid_field', 'Unsupported command action', 400);
  }

  /** operation.*: managed review and effect operations. */
  async operation({ id, method, body, w }: BridgeRequest): Promise<unknown> {
    if (this.s.children?.owned(id))
      throw new Error('Child operation authority is read-only probe only');
    if (!this.s.managed || !w.attempt) throw new Error('No active managed attempt');
    this.s.assertActive(id, w.epoch, w.attempt);
    if (method === 'operation.prepare') {
      if (body.kind !== 'review' && body.kind !== 'effect')
        throw new Error('Unsupported operation kind');
      if (body.kind === 'effect' && !this.s.options.effectsEnabled)
        throw new Error('Effects are disabled');
      return await this.s.managed.prepare(
        id,
        w.epoch,
        w.attempt,
        string(body.tool_call_id, 'tool_call_id', 512),
        body.kind,
        string(body.target, 'target', 256),
        string(body.value, 'value', 4096),
      );
    }
    const op = this.s.managed.operation(string(body.operation_id, 'operation_id', 128));
    if (op.session_id !== id || op.worker_epoch !== w.epoch || op.attempt_id !== w.attempt)
      throw new Error('Operation belongs to another invocation');
    return method === 'operation.run' ? this.s.managed.start(op.id, id, w.epoch, w.attempt) : op;
  }
}
