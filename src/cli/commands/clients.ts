import { acp } from '../../acp/index.js';
import { attach } from '../../tui/index.js';
import type { CliContext } from './context.js';

export const CODE_HELP = `salaam code [--continue | --new | --resume] [--cwd DIR] [--takeover]
salaam here   (the same)
salaam -c     (short for salaam code --continue)

Work in this folder with one command: start the service if it is not running, then continue
the folder's latest session (the default), start a new local coding session (--new), or pick
any session from a list (--resume), this folder's sessions first. No session id needed.
SALAAM_TERMINAL_STATUS=off stops the window-title and Herdr status reports.`;
export const TUI_HELP = `salaam tui [--session SESSION_ID] [--observe|--takeover] [--theme night|paper]
           [--cwd DIR] [--coding-root PRIVATE_DIR] [--coding-socket DOCKER_SOCKET]

Bare sal opens the same Salaam terminal interface in a TTY.
Ctrl+K (empty composer) or F2 actions · Ctrl+P sessions · Ctrl+N new · Ctrl+O approvals
Alt+G changes · Ctrl+T commands · Ctrl+G external editor · Ctrl+R history search
F5 refresh · !command shell · Ctrl+C stops/clears, twice to detach.
? on an empty composer (or F1) shows the keys for where you are.
Work continues in the service when the terminal closes.`;
export const REMOTE_HELP = `salaam remote SSH_HOST [--remote-bin ABSOLUTE_PATH] [--state REMOTE_DIR]
              [--session SESSION_ID] [--observe|--takeover] [--theme night|paper]

Open the Salaam TUI over SSH on an existing execution host. The remote binary
must be installed already. State paths belong to that host. No key is copied;
the host-local service owns the session. SSH agent forwarding is disabled.`;
export const ACP_HELP = `salaam acp [--state DIR] [--local | --coding]

Run the ACP v1 stdio client adapter against an already running Salaam service.
--local creates your desk session in the editor's project folder, the same as
salaam in a terminal there: modes, approvals with diffs, rules and /rewind.
--coding creates owned coding sessions; the service must have --coding-root.
Loading an existing session preserves its original tool authority.`;
export const ATTACH_HELP = `salaam attach SESSION_ID [--observe|--takeover] [--plain]

Reconnect to a persistent session. Ctrl-C or Ctrl-D detaches while work continues.
--observe watches without taking control; --takeover replaces the controller.
A TTY opens the Salaam TUI. --plain retains the line client (:help).
Piped attachments use the line client automatically.`;

/** salaam remote SSH_HOST: the TUI over SSH. */
export async function remoteCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, explicitState, group, verb } = ctx;
  if (group === 'remote' && verb) {
    const { remote } = await import('../remote.js');
    const theme = option('--theme');
    if (theme && !['night', 'paper'].includes(theme))
      throw new Error('Choose --theme night or paper.');
    await remote({
      host: verb,
      executable: option('--remote-bin'),
      state: explicitState,
      session: option('--session'),
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
      theme: theme as 'night' | 'paper' | undefined,
    });
    return true;
  }
  return false;
}
/** salaam code (and here, -c): this folder's session. */
export async function codeCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, state, group } = ctx;
  if (group === 'code' || group === 'here') {
    const { parseCodeStart } = await import('../../tui/session-pick.js');
    const start = parseCodeStart(args.slice(1));
    const { tui } = await import('../../tui/app.js');
    await tui({
      state,
      start,
      cwd: option('--cwd'),
      takeover: args.includes('--takeover'),
      codingRoot: option('--coding-root'),
      codingSocket: option('--coding-socket'),
    });
    return true;
  }
  return false;
}
/** salaam tui, or bare salaam with TUI options. */
export async function tuiCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, state, group } = ctx;
  if (
    !group ||
    group === 'tui' ||
    [
      '--session',
      '--observe',
      '--takeover',
      '--theme',
      '--cwd',
      '--coding-root',
      '--coding-socket',
    ].includes(group)
  ) {
    const { tui } = await import('../../tui/app.js');
    const theme = option('--theme');
    if (theme && !['night', 'paper'].includes(theme))
      throw new Error('Choose --theme night or paper.');
    await tui({
      state,
      session: option('--session'),
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
      theme: theme as 'night' | 'paper' | undefined,
      cwd: option('--cwd'),
      codingRoot: option('--coding-root'),
      codingSocket: option('--coding-socket'),
    });
    return true;
  }
  return false;
}
/** salaam acp: an editor over ACP stdio. */
export async function acpCommand(ctx: CliContext): Promise<boolean> {
  const { args, state, group } = ctx;
  if (group === 'acp') {
    await acp(state, { coding: args.includes('--coding'), local: args.includes('--local') });
    return true;
  }
  return false;
}
/** salaam attach SESSION_ID: the TUI, or a plain attach without a terminal. */
export async function attachCommand(ctx: CliContext): Promise<boolean> {
  const { args, state, group, verb } = ctx;
  if (group === 'attach' && verb) {
    if (process.stdin.isTTY && process.stdout.isTTY && !args.includes('--plain')) {
      const { tui } = await import('../../tui/app.js');
      await tui({
        state,
        session: verb,
        observe: args.includes('--observe'),
        takeover: args.includes('--takeover'),
      });
      return true;
    }
    await attach(state, verb, {
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
    });
    return true;
  }
  return false;
}
