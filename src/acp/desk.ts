import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../core/config.js';
import { credentialPath } from '../providers/credentials.js';
import { providerRoute } from '../providers/config.js';
import { deskUsesAnthropic } from '../tui/session-pick.js';
import { call } from '../core/transport.js';
import type { PermissionMode, PermissionPolicy, SessionAccess } from '../runtime/autonomy.js';
import type { LocalEdit } from '../local/edits.js';
import type { TurnCheckpoint } from '../runtime/turn-rewind.js';
import { relativeTime } from '../tui/session-pick.js';

/** What an editor shows for a desk session: the same choices as Shift+Tab, plus full access.
 * YOLO is listed only while it is on, because turning it on needs "yolo" typed in the terminal. */
export type DeskMode = 'review' | 'accept-edits' | 'auto' | 'full-access' | 'yolo';
const MODES: { id: DeskMode; name: string; description: string }[] = [
  { id: 'review', name: 'Review', description: 'Asks before every edit and command' },
  {
    id: 'accept-edits',
    name: 'Accept edits',
    description: 'Edits in the project apply at once; commands ask',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Project edits and sandboxed commands run at once; the rest asks',
  },
  {
    id: 'full-access',
    name: 'Full access',
    description: 'No OS sandbox; only dangerous commands ask',
  },
];
const YOLO = {
  id: 'yolo' as const,
  name: 'YOLO',
  description: 'No approvals at all and no sandbox. Turn it off in the terminal with /yolo',
};

export interface DeskPermissions {
  policy: PermissionPolicy;
  full_access_allowed?: boolean;
}
export function deskMode(policy: PermissionPolicy): DeskMode | PermissionMode {
  if (policy.access === 'yolo') return 'yolo';
  if (policy.access === 'full') return 'full-access';
  return policy.mode;
}
/** `modes` and the matching `configOptions`, kept in step (ACP asks agents to send both). */
export function modeState(p: DeskPermissions) {
  const current = deskMode(p.policy);
  const list = MODES.filter((m) => m.id !== 'full-access' || p.full_access_allowed !== false);
  if (current === 'yolo') list.push(YOLO);
  else if (!list.some((m) => m.id === current))
    list.unshift({ id: current as DeskMode, name: current, description: 'Set in the terminal' });
  return {
    modes: { currentModeId: current, availableModes: list },
    configOptions: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: current,
        options: list.map((m) => ({ value: m.id, name: m.name, description: m.description })),
      },
    ],
  };
}
/** The policy a chosen mode asks for. Picking a mode turns full access off; full access runs in
 * auto, so edits and commands go ahead and only dangerous commands ask. */
export function policyFor(
  mode: string,
  allowed: { full?: boolean } = {},
): { mode: PermissionMode; paths: string[]; access?: SessionAccess } {
  if (mode === 'review' || mode === 'accept-edits' || mode === 'auto') return { mode, paths: [] };
  if (mode === 'full-access') {
    if (allowed.full === false)
      throw new Error(
        'The operator does not allow full access on this host. Commands stay in the OS sandbox.',
      );
    return { mode: 'auto', paths: [], access: 'full' };
  }
  if (mode === 'yolo')
    throw new Error('YOLO is turned on only in the terminal: run /yolo there and type yolo.');
  throw new Error('Unknown mode ' + JSON.stringify(mode));
}
export const FULL_ACCESS_WARNING =
  'Later commands in this session run WITHOUT the OS sandbox: they can read and change any file your user can, and reach the network directly. They run without asking, except commands the danger check calls dangerous (force pushes, deletes, publishing, credentials, anything it cannot read), which still ask and say why. Pick another mode to turn it off.';

/** ACP diff content for an edit request: absolute paths, null old text for a new file. */
export function editDiffs(root: string, edits: readonly LocalEdit[]) {
  return edits.map((e) => ({
    type: 'diff' as const,
    path: isAbsolute(e.path) ? e.path : join(root, e.path),
    oldText: e.before,
    newText: e.after,
  }));
}

/** Why an approval asks, from the reviewed text and the mode, in one line. */
export function askReason(value: string, mode: PermissionMode | undefined): string {
  const danger = /^Dangerous \(([^)]+)\): (.*)$/m.exec(value);
  if (danger) return `Asks because this command is dangerous (${danger[1]}): ${danger[2]}`;
  const outside = /^Outside the sandbox: (.*?)\. This one command/m.exec(value);
  if (outside) return `Asks because it wants to run outside the sandbox: ${outside[1]}`;
  if (/^Publishes: /m.test(value))
    return 'Asks because pushing and opening pull requests always ask.';
  if (/^May listen: /m.test(value))
    return 'Asks because this command may accept network connections; macOS cannot limit it to localhost.';
  const edit = /^(---|\+\+\+) /m.test(value) && !/\nCommand:\n/.test(value);
  if (mode === 'review') return 'Asks because review mode asks before every edit and command.';
  if (mode === 'accept-edits' && !edit)
    return 'Asks because accept edits still asks before commands.';
  if (mode === 'auto')
    return edit
      ? 'Asks because this edit is outside what auto mode approves on its own.'
      : 'Asks because auto mode approves only sandboxed commands it can read.';
  return 'Asks because nothing approves this request on its own.';
}

export const DESK_COMMANDS = [
  {
    name: 'rewind',
    description: 'Put the files back as they were before an earlier turn',
    input: { hint: 'turn number (leave empty to list turns)' },
  },
];
/** `/rewind`, `/rewind 3`. Anything else is not a desk command and goes to the model. */
export function parseDeskCommand(text: string): { command: 'rewind'; turn?: number } | null {
  const match = /^\/rewind(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!match) return null;
  if (match[1] === undefined) return { command: 'rewind' };
  const turn = Number(match[1]);
  if (!Number.isSafeInteger(turn) || turn < 1)
    throw new Error('Use /rewind with a turn number from the list, e.g. /rewind 3.');
  return { command: 'rewind', turn };
}
export function checkpointList(points: readonly TurnCheckpoint[], now = Date.now()): string {
  if (!points.length) return 'No turns to go back to yet.';
  return [
    'Turns you can go back to (the files as they were before each turn ran):',
    '',
    ...points
      .slice()
      .reverse()
      .map(
        (p) =>
          `- Turn ${p.turn} · ${relativeTime(p.at, now)} · ${p.text.split('\n')[0]!.slice(0, 80)}`,
      ),
    '',
    'Run /rewind followed by a turn number to review and restore its files.',
  ].join('\n');
}
/** Zed cannot follow a rewind into a new session, so from the editor only files are restored. */
export const REWIND_CHOICES = [
  { optionId: 'files', name: 'Restore files', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
];
export const CONVERSATION_REWIND_NOTE =
  'To go back in the conversation too, run /rewind in the terminal (salaam -c opens this session): it continues in a new session.';

/** An editor starts the adapter on its own, so the desk session starts the service the way
 * `salaam` in a terminal does, instead of failing with a missing socket. */
export async function ensureDeskService(state: string): Promise<void> {
  const socket = join(state, 'operator.sock');
  try {
    await call(socket, '/v1/health');
    return;
  } catch {}
  await promisify(execFile)(
    process.execPath,
    [join(ROOT, 'bin/salaam.mjs'), 'service', 'start', '--state', state, '--provider', 'offline'],
    { timeout: 20000, maxBuffer: 65536 },
  );
  await call(socket, '/v1/health');
}
/** The model a new desk session uses, chosen as `salaam` in a terminal chooses it: Anthropic when
 * the service runs the offline default and you have saved an Anthropic key. */
export function deskRoute(
  serviceProvider: string | undefined,
  hasKey = existsSync(credentialPath()) || existsSync(credentialPath() + '.json'),
): { provider: string; model: string } | undefined {
  if (!deskUsesAnthropic(false, serviceProvider, hasKey)) return undefined;
  const route = providerRoute('anthropic');
  return { provider: route.provider, model: route.model };
}
