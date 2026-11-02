// The coding module's public entry point: only what other modules import. Keep it minimal.
export { CodingWork, type CommandRun } from './coding.js';
export { DockerCodingExecutor, type ExecutionBackend } from './executor.js';
export { filePath, readTree, validateTree, type Workspace, Workspaces } from './workspaces.js';
