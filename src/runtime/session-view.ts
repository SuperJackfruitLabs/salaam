// How a session looks from outside: what the store recorded, made unhealthy when its execution
// authority is revoked or no ready supervised worker of the current epoch stands behind it.
import type { McpServerProvenance, Session } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { ChildWork } from '../workers/index.js';
import type { TaskContext } from './task-context.js';
import type { Worker } from './worker.js';

export interface SessionViewDeps {
  readonly store: Store;
  readonly children?: ChildWork;
  readonly tasks: TaskContext;
  providerCapabilities(): {
    output_token_cap: boolean;
    durable_tasks: boolean;
    warning: string | null;
  };
  mcpServers(id: string): McpServerProvenance[] | undefined;
}

export function inspectSession(
  s: SessionViewDeps,
  id: string,
  worker: () => Worker | undefined,
): Session {
  if (s.store.execution.revocation(id)) {
    const session = s.store.session(id);
    return {
      ...session,
      state: ['starting', 'ready'].includes(session.state) ? 'unhealthy' : session.state,
      capabilities: [],
      error: 'Session execution authority revoked',
    };
  }
  const externalChild = s.children?.owned(id);
  if (externalChild && s.store.workerBoundary.view(externalChild.id).binding.external)
    return s.store.session(id);
  const child = s.children?.owned(id);
  const cap = child
    ? s.store.workerBoundary.view(child.id).binding.agent?.output_cap
    : s.store.localWorkspace(id)
      ? s.store.localOutputCap(id)
      : undefined;
  const state = {
    ...s.store.session(id),
    provider_route: s.store.providerRoute(id) ?? undefined,
    project_instructions: s.tasks.instructions?.summary(id) ?? undefined,
    provider_capabilities:
      cap === undefined
        ? s.providerCapabilities()
        : {
            output_token_cap: cap,
            durable_tasks: true,
            warning: cap
              ? null
              : 'No provider-enforced output cap; tasks must explicitly disable token budgeting',
          },
    ...(s.mcpServers(id) ? { mcp_servers: s.mcpServers(id) } : {}),
  };
  const w = worker();
  if (w?.invalid) return { ...state, state: 'unhealthy', capabilities: [], error: w.invalid };
  if (state.state === 'ready' && (!w?.ready || w.stopping))
    return {
      ...state,
      state: 'unhealthy',
      capabilities: [],
      error: 'No ready supervised worker; reconciliation required',
    };
  if (w && w.epoch !== state.epoch)
    return {
      ...state,
      state: 'unhealthy',
      capabilities: [],
      error: 'Worker epoch changed; reconciliation required',
    };
  return state;
}
