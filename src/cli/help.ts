import { A2A_HELP } from './commands/a2a.js';
import { HARNESS_HELP } from './commands/harness.js';
import { WORKERS_HELP, TEAM_HELP, AGENTS_HELP } from './commands/workers.js';
import { CODE_HELP, TUI_HELP, REMOTE_HELP, ACP_HELP, ATTACH_HELP } from './commands/clients.js';
import { WORKSPACE_HELP, COMMANDS_HELP, EXECUTION_HELP } from './commands/workspace.js';
import { HOST_HELP } from './commands/host.js';
import { SCHEDULES_HELP, INBOX_HELP, JOBS_HELP, TASKS_HELP } from './commands/work.js';
import {
  ARTIFACTS_HELP,
  TASK_HELP,
  HISTORY_HELP,
  COMPACTIONS_HELP,
  SESSION_HELP,
} from './commands/session.js';
import { PROVIDERS_HELP, MODELS_HELP, AUTH_HELP } from './commands/providers.js';
import { SERVICE_HELP } from './commands/service.js';
import { APPROVALS_HELP, OPERATIONS_HELP, CHILDREN_HELP } from './commands/review.js';

/** Each group's usage, kept beside its command in commands/. */
const commands: Record<string, string> = {
  a2a: A2A_HELP,
  harness: HARNESS_HELP,
  workers: WORKERS_HELP,
  team: TEAM_HELP,
  agents: AGENTS_HELP,
  code: CODE_HELP,
  tui: TUI_HELP,
  remote: REMOTE_HELP,
  workspace: WORKSPACE_HELP,
  commands: COMMANDS_HELP,
  execution: EXECUTION_HELP,
  acp: ACP_HELP,
  artifacts: ARTIFACTS_HELP,
  host: HOST_HELP,
  schedules: SCHEDULES_HELP,
  inbox: INBOX_HELP,
  jobs: JOBS_HELP,
  tasks: TASKS_HELP,
  task: TASK_HELP,
  history: HISTORY_HELP,
  compactions: COMPACTIONS_HELP,
  providers: PROVIDERS_HELP,
  models: MODELS_HELP,
  auth: AUTH_HELP,
  service: SERVICE_HELP,
  session: SESSION_HELP,
  attach: ATTACH_HELP,
  approvals: APPROVALS_HELP,
  operations: OPERATIONS_HELP,
  children: CHILDREN_HELP,
};
const globalOptions = `Global options:
  --state DIR    Service state directory (or SALAAM_STATE_DIR).
                 Default: ~/.local/state/salaam
  -h, --help     Show help without starting a service or model request.
  -V, --version  Show the installed version.`;
export function cliHelp(group?: string): string | undefined {
  if (group === 'here') group = 'code';
  if (group) return commands[group] ? `${commands[group]}\n\n${globalOptions}` : undefined;
  return `Salaam — persistent coding sessions

Usage: salaam <command> [options]
       sal <command> [options]

Commands:
  code          Work in this folder: continue its session or start one (also: here, -c)
  tui           Open the Salaam terminal interface (also bare sal)
  remote        Open the same session over SSH
  providers     List pinned Pi providers and capabilities
  models        List pinned chat models
  auth          Configure provider credentials or OAuth
  service       Start, inspect or stop the session service
  session       Create, inspect, submit, resume or cancel work
  mcp           Declare operator MCP servers (add, list, rm)
  attach        Open an interactive terminal on a session
  acp           Connect an editor over ACP v1 stdio
  approvals     Inspect, approve or deny managed operations
  operations    Inspect, reconcile or resolve effect outcomes
  children      Inspect, read or acknowledge durable child results
  tasks         Durable plans, verification, budgets and checkpoints
  jobs          Durable one-shot jobs and recovery
  schedules     Fresh recurring occurrences and explicit missed-run rules
  inbox         Durable shared operator attention
  host          Pinned host bootstrap, supervision and health
  task          Inspect and update durable task facts
  history       Retrieve older history and evidence
  artifacts     Save durable text evidence
  compactions   Inspect or cancel a managed checkpoint
  execution     Prove the container boundary with disposable fixtures
  workspace     Inspect coding copies, review diffs or acknowledge human edits
  agents        Inspect and admit specialist profiles
  team          Assign task steps and inspect the durable team inbox
  workers       Inspect and explicitly integrate isolated coding proposals
  harness       Prepare, inspect and reconcile pinned external workers
  a2a           Configure bounded peer analysis and inspect remote work
  commands      Start, inspect, cancel or reconcile isolated commands

${globalOptions}

Get started:
  salaam auth set anthropic
  salaam service start --provider anthropic
  sal session create --cwd "$PWD"
  sal attach SESSION_ID

Run salaam <command> --help for command usage.
Both salaam and sal are executable names for the same CLI.`;
}
const valueOptions = new Set([
  '--theme',
  '--remote-bin',
  '--state',
  '--cwd',
  '--request-id',
  '--reason',
  '--text',
  '--attempt',
  '--provider',
  '--model',
  '--max-output-tokens',
  '--workspace-id',
  '--effect-socket',
  '--session',
  '--digest',
  '--revision',
  '--outcome',
  '--evidence',
  '--result',
  '--kind',
  '--supersedes',
  '--artifact-id',
  '--entry-id',
  '--offset',
  '--task-version',
  '--docker-socket',
  '--scratch-root',
  '--report',
  '--run-id',
  '--coding-root',
  '--coding-socket',
  '--harness-config',
  '--a2a-config',
  '--agentpod-config',
  '--a2a-listen-config',
  '--tools-user',
  '--assignment',
  '--peer',
  '--peer-client',
  '--file',
  '--endpoint',
  '--card-url',
  '--card-file',
  '--addresses',
  '--files',
  '--retention',
  '--credential-file',
  '--tenant',
  '--skill',
  '--runtime-root',
  '--arch',
  '--target',
  '--id',
  '--runtime',
  '--invocations',
  '--step-key',
  '--command',
  '--plan',
  '--step',
  '--review',
  '--continue-attempt',
  '--check',
  '--exception-reason',
  '--evidence-artifact',
  '--checkpoint',
  '--workspace-revision',
  '--workspace-digest',
  '--max-steps',
  '--name',
  '--key',
  '--schedule',
  '--status',
  '--manifest',
  '--config',
  '--pin',
  '--platform',
]);
/** Skip option values so a prompt containing "--help" stays a prompt. */
export function hasHelpFlag(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (valueOptions.has(args[index]!)) {
      index++;
      continue;
    }
    if (args[index] === '--help' || args[index] === '-h') return true;
  }
  return false;
}
