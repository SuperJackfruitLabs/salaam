// The execution module's public entry point: only what other modules import. Keep it minimal.
export {
  BoundaryBroker,
  boundaryConfig,
  decodeLogs,
  engineJson,
  engineRequest,
  type EngineRequest,
  EXECUTION_STATUS,
  inspectBoundary,
} from './boundary.js';
export { type EffectConnector, SocketEffectConnector } from './effect-connector.js';
export { ManagedWork, operationBinding, type OperationResolution } from './managed.js';
export { proveExecutionBoundary } from './proof.js';
export { bindWorkTrace, traceParent, workTraceHeader } from './trace.js';
