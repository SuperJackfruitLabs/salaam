// The execution module's public entry point: only what other modules import. Keep it minimal.
export {
  BoundaryBroker,
  boundaryConfig,
  type ContainerCreateConfig,
  type CreateMount,
  decodeLogs,
  type EngineContainer,
  type EngineImage,
  type EngineInfo,
  type EngineMount,
  engineJson,
  engineRequest,
  type EngineRequest,
  type EngineVersion,
  EXECUTION_STATUS,
  inspectBoundary,
} from './boundary.js';
export { type EffectConnector, SocketEffectConnector } from './effect-connector.js';
export { ManagedWork, operationBinding, type OperationResolution } from './managed.js';
export { proveExecutionBoundary } from './proof.js';
export { bindWorkTrace, traceParent, workTraceHeader } from './trace.js';
