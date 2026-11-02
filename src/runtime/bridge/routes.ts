// The bridge's route table: which handler takes each kind of request. No method matches two
// routes; they are listed in the order bridge() has always tried them.
import { exact, prefix, type BridgeHandler, type BridgeRoute } from './bridge.js';
import { ContextHandlers, type ContextDeps } from './context.js';
import { DelegationHandlers, type DelegationDeps } from './delegation.js';
import { DeskHandlers, type DeskDeps } from './desk.js';
import { IntegrationHandlers, type IntegrationDeps } from './integrations.js';
import { ProviderHandlers, type ProviderDeps } from './provider.js';
import { StationHandlers, type StationDeps } from './station.js';
import { WorkHandlers, type WorkDeps } from './work.js';

/** Everything the handlers use, together; the supervisor provides it. */
export type BridgeDeps = ContextDeps &
  DelegationDeps &
  DeskDeps &
  IntegrationDeps &
  ProviderDeps &
  StationDeps &
  WorkDeps;

const at = (matches: (method: string) => boolean, handle: BridgeHandler): BridgeRoute => ({
  matches,
  handle,
});

export function bridgeRoutes(deps: BridgeDeps): BridgeRoute[] {
  const delegation = new DelegationHandlers(deps),
    provider = new ProviderHandlers(deps),
    integrations = new IntegrationHandlers(deps),
    station = new StationHandlers(deps),
    desk = new DeskHandlers(deps),
    work = new WorkHandlers(deps),
    context = new ContextHandlers(deps);
  return [
    at(prefix('team.'), (r) => delegation.team(r)),
    at(exact('specialist.read', 'specialist.report'), (r) => delegation.specialist(r)),
    at(exact('provider.auth'), (r) => provider.auth(r)),
    at(prefix('operator_mcp.'), (r) => integrations.operatorMcp(r)),
    at(prefix('toolkit.'), (r) => integrations.toolkit(r)),
    at(prefix('mcp.'), (r) => integrations.mcp(r)),
    at(exact('board.read', 'board.status'), (r) => station.board(r)),
    at(prefix('station.'), (r) => station.station(r)),
    at(exact('web.search', 'web.fetch'), (r) => desk.web(r)),
    at(prefix('bgtask.'), (r) => desk.backgroundTask(r)),
    at(
      (method) => method.startsWith('local.') && method !== 'local.read',
      (r) => desk.local(r),
    ),
    at(exact('local.read'), (r) => desk.workspaceRead(r)),
    at(exact('coding.files', 'coding.command'), (r) => work.coding(r)),
    at(exact('operation.prepare', 'operation.status', 'operation.run'), (r) => work.operation(r)),
    at(prefix('child.'), (r) => delegation.child(r)),
    at(exact('context'), (r) => context.context(r)),
    at(exact('history'), (r) => context.history(r)),
    at(exact('compaction.plan'), (r) => context.compactionPlan(r)),
    at(exact('usage'), (r) => provider.usage(r)),
    at(exact('model'), (r) => provider.model(r)),
    at(exact('policy', 'tool'), (r) => context.policy(r)),
  ];
}
