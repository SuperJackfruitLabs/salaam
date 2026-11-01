// The local module's public entry point: only what other modules import. Keep it minimal.
export {
  type ApprovalRule,
  ApprovalRules,
  onceOnlyReason,
  type StoredRule,
} from './approval-rules.js';
export {
  configurePermissions,
  nextMode,
  type PermissionMode,
  permissionPolicy,
  type PermissionPolicy,
  type SessionAccess,
} from './autonomy.js';
export { LocalCoding, type LocalSandbox } from './coding.js';
export { DEFAULT_COMMAND_NETWORK_SOCKET } from './command-network.js';
export {
  chooseLocalSandbox,
  resolveReadPaths,
  SANDBOX_LEVELS,
  type SandboxKind,
  sandboxLabel,
  type SandboxLevel,
} from './command-sandbox.js';
export { DangerClassifier, loadDangerClassifierOptions } from './danger-classifier.js';
export { localDiff } from './diff.js';
export { type LocalEdit } from './edits.js';
export {
  branchInstruction,
  commitInstruction,
  currentBranch,
  defaultBase,
  forgeTool,
  loadGitPrefs,
  prInstruction,
  validBranchName,
} from './git-helpers.js';
export {
  describeHooks,
  type HookEvent,
  type HookOutcome,
  Hooks,
  type HookSource,
} from './hooks.js';
export { shellPassthrough, typedText } from './shell-passthrough.js';
export { probeToolsUser, serviceToolIdentity, type ToolIdentity } from './tool-identity.js';
export { applyUndo, reconcileUndo, reviewUndo, type UndoReview } from './undo.js';
export { readLocalWorkspace } from './workspace.js';
