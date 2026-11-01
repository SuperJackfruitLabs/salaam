// The workers module's public entry point: only what other modules import. Keep it minimal.
export { ChildWork } from './children.js';
export { type ExternalBackend, type ExternalHooks } from './external-runtime.js';
export { ExternalWork } from './external-work.js';
export { repositoryPath, RepositorySnapshots } from './repository-snapshots.js';
export { WorkerWorkspaces } from './worker-workspaces.js';
export { type WorkspaceChange, workspaceDiff } from './workspace-diff.js';
