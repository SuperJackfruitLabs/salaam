#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../core/index.js';
import { cliHelp, hasHelpFlag } from './help.js';
import { mcpCli, MCP_HELP } from './mcp-commands.js';
import type { CliCommand, CliContext } from './commands/context.js';
import { a2aCommand } from './commands/a2a.js';
import { externalCommand, harnessCommand } from './commands/harness.js';
import { agentsCommand, teamCommand, workersCommand } from './commands/workers.js';
import { hostCommand } from './commands/host.js';
import {
  acpCommand,
  attachCommand,
  codeCommand,
  remoteCommand,
  tuiCommand,
} from './commands/clients.js';
import { commandsCommand, executionCommand, workspaceCommand } from './commands/workspace.js';
import { authCommand, modelsCommand, providersCommand } from './commands/providers.js';
import { inboxCommand, jobsCommand, schedulesCommand, tasksCommand } from './commands/work.js';
import {
  compactionsCommand,
  historyCommand,
  recordCommand,
  sessionCommand,
  sessionReadCommand,
  sessionRevokeCommand,
  sessionSubmitCommand,
  taskInspectCommand,
} from './commands/session.js';
import { approvalsCommand, childrenCommand, operationsCommand } from './commands/review.js';
import { serviceCommand, serviceStartCommand } from './commands/service.js';

/** Every command group, in the order the CLI tries them; the first that handles a command wins.
 * Groups that share a name (session, task, harness and a2a) keep their order relative to each
 * other. */
const COMMANDS: readonly CliCommand[] = [
  a2aCommand,
  harnessCommand,
  externalCommand,
  workersCommand,
  teamCommand,
  agentsCommand,
  hostCommand,
  remoteCommand,
  codeCommand,
  tuiCommand,
  workspaceCommand,
  commandsCommand,
  executionCommand,
  acpCommand,
  providersCommand,
  modelsCommand,
  authCommand,
  schedulesCommand,
  inboxCommand,
  jobsCommand,
  tasksCommand,
  taskInspectCommand,
  historyCommand,
  recordCommand,
  compactionsCommand,
  sessionReadCommand,
  childrenCommand,
  approvalsCommand,
  operationsCommand,
  sessionRevokeCommand,
  attachCommand,
  sessionSubmitCommand,
  serviceStartCommand,
  serviceCommand,
  sessionCommand,
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    console.log('salaam ' + VERSION);
    return;
  }
  if (args[0] === '-c' || args[0] === '--continue') {
    const { continueArgs } = await import('../tui/session-pick.js');
    args.splice(0, args.length, ...continueArgs(args)!);
  }
  if (args[0] === 'mcp') {
    // Parsed before global help: a declared command's own flags follow "--".
    const rest = args.slice(1);
    const dash = rest.indexOf('--');
    const flags = dash < 0 ? rest : rest.slice(0, dash);
    if (!rest.length || flags.includes('--help') || flags.includes('-h')) console.log(MCP_HELP);
    else console.log(mcpCli(rest));
    return;
  }
  if (
    (!args.length && !(process.stdin.isTTY && process.stdout.isTTY)) ||
    args[0] === 'help' ||
    hasHelpFlag(args)
  ) {
    const group = args[0] === 'help' ? args[1] : args[0]?.startsWith('-') ? undefined : args[0];
    const help = cliHelp(group);
    if (!help) {
      console.error('Unknown command. Run salaam --help.');
      process.exitCode = 2;
      return;
    }
    console.log(help);
    return;
  }
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return;
    const value = args[i + 1];
    if (!value) throw new Error(`Missing ${name}`);
    args.splice(i, 2);
    return value;
  };
  const explicitState = option('--state');
  const state = resolve(
    explicitState ?? process.env.SALAAM_STATE_DIR ?? join(homedir(), '.local/state/salaam'),
  );
  const foreground = args.includes('--foreground');
  if (foreground) args.splice(args.indexOf('--foreground'), 1);
  const socket = join(state, 'operator.sock');
  const [group, verb, id] = args;
  const ctx: CliContext = {
    args,
    option,
    state,
    explicitState,
    socket,
    foreground,
    group,
    verb,
    id,
  };
  for (const command of COMMANDS) if (await command(ctx)) return;
  const help = cliHelp(group);
  if (args.length === 1 && help) console.log(help);
  else {
    console.error('Unknown or incomplete command. Run salaam --help.');
    process.exitCode = 2;
  }
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
