// Requests about the task itself: its frame, history and managed compaction, and the policy gate
// every tool call passes.
import type { Store } from '../../store/index.js';
import type { TaskContext } from '../task-context.js';
import type { BridgeRequest } from './bridge.js';

export interface ContextDeps {
  readonly store: Store;
  readonly tasks: TaskContext;
  tools(id: string): string[];
}

export class ContextHandlers {
  constructor(private readonly s: ContextDeps) {}

  /** context: the current task frame. */
  context({ id, w }: BridgeRequest): unknown {
    return { frame: this.s.tasks.frame(id, w.binding), version: this.s.tasks.state(id).version };
  }

  /** history: earlier entries and evidence. */
  history({ id, body }: BridgeRequest): unknown {
    return this.s.tasks.history(id, body);
  }

  /** compaction.plan: the summary for a granted managed compaction. */
  compactionPlan({ id, w }: BridgeRequest): unknown {
    if (!w.compaction || w.attempt) throw new Error('No managed compaction grant');
    const work = this.s.tasks.compaction(w.compaction);
    if (
      work.state !== 'running' ||
      work.epoch !== w.epoch ||
      work.task_version !== this.s.tasks.state(id).version
    )
      throw new Error('Compaction grant is stale');
    return {
      id: work.id,
      task_version: work.task_version,
      summary:
        'Salaam task checkpoint. Earlier conversation is available through salaam_history. Explicit facts below are authoritative; superseded facts remain historical.\n' +
        this.s.tasks.frame(id, w.binding),
    };
  }

  /** policy and tool: a tool call inside the session policy. */
  policy({ id, method, body, w }: BridgeRequest): unknown {
    this.s.tasks.admitted?.assertFresh(id);
    this.s.store.taskGrantCheck?.(id);
    if (!this.s.tools(id).includes(String(body.tool))) throw new Error('Tool is outside policy');
    this.s.store.transaction(() => {
      this.s.store.event(id, method === 'tool' ? 'tool.granted' : 'policy.allowed', {
        attempt_id: w.attempt ?? null,
        epoch: w.epoch,
        tool: body.tool,
      });
    });
    return { ok: true };
  }
}
