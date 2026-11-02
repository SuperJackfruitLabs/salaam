// The mcp module's public entry point: only what other modules import. Keep it minimal.
export { validateManagedMcpDeclarations } from './acp.js';
export { McpAdmission, readMcpProfile } from './admission.js';
export { mcpCatalogDigest, McpInputFailure } from './http.js';
export {
  declarationDigest,
  type McpDeclaration,
  mergeMcpProvenance,
  OperatorMcp,
  operatorMcpPath,
  readOperatorMcpFile,
  validateDeclaration,
  writeOperatorMcpFile,
} from './operator-mcp.js';
export { mcpAdmissionView } from './protocol.js';
export { admittedMcpSchema } from './schema.js';
export {
  ManagedStdioTransport,
  type StdioLaunch,
  type StdioLifecycle,
  type StdioProcessLaunch,
  verifyStdioProcessLaunch,
} from './stdio.js';
export { McpWork, type McpWorkerBinding } from './work.js';
