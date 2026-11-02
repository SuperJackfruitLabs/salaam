import { humanTool, safeText } from './theme.js';

/**
 * One compact line per tool call in the conversation (trial polish #9): what ran and how it
 * ended, e.g. `Edit src/x.ts +3 −1` or `Bash npm test ✓ exit 0` with the last output lines.
 * Built only from the recorded tool activity; it never reads the workspace.
 */
export interface ToolLine {
  state: 'running' | 'finished' | 'failed';
  label: string;
  /** The last output lines of a finished command (at most `tail` lines). */
  tail: string[];
  /** A command's full output as text, for the transcript; absent when only the raw record exists. */
  full?: string;
}
const lineCount = (text: string) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);
function short(text: string, max = 60): string {
  const first = safeText(text).split('\n')[0]!.trim();
  return first.length > max ? first.slice(0, max - 1) + '…' : first;
}
/** The recorded result of a local command: its exit code and output, even from a truncated record. */
function commandResult(output?: string): { exit?: number | null; text?: string } {
  if (!output) return {};
  try {
    const parsed = JSON.parse(output) as { exit_code?: number | null; output?: string };
    return { exit: parsed.exit_code, text: parsed.output };
  } catch {
    const exit = /"exit_code":(-?\d+|null)/.exec(output)?.[1];
    return exit === undefined ? {} : { exit: exit === 'null' ? null : Number(exit) };
  }
}
export function toolLine(
  tool: string,
  input: string | undefined,
  finished: { failed?: boolean; output?: string } | undefined,
  tail = 3,
): ToolLine {
  const state = !finished ? 'running' : finished.failed ? 'failed' : 'finished';
  let args: {
    action?: string;
    command?: string;
    background?: boolean;
    edits?: {
      path?: string;
      content?: string;
      sha256?: string | null;
      replacements?: { old: string; new: string }[];
    }[];
  } = {};
  try {
    args = JSON.parse(input ?? '{}');
  } catch {}
  if (tool === 'salaam_local' && args.action === 'edit' && Array.isArray(args.edits)) {
    let added = 0,
      removed = 0,
      created = false;
    for (const edit of args.edits) {
      if (edit.replacements?.length)
        for (const r of edit.replacements) {
          added += lineCount(r.new);
          removed += lineCount(r.old);
        }
      else if (typeof edit.content === 'string') {
        added += lineCount(edit.content);
        if (edit.sha256 === null) created = true;
      }
    }
    const what =
      args.edits.length === 1
        ? safeText(String(args.edits[0]!.path ?? ''))
        : `${args.edits.length} files`;
    return {
      state,
      label: `Edit ${what} +${added} −${removed}${created ? ' (new)' : ''}`,
      tail: [],
    };
  }
  if (tool === 'salaam_local' && args.action === 'command' && typeof args.command === 'string') {
    const result = commandResult(finished?.output);
    const ended =
      !finished || args.background
        ? args.background && finished
          ? ' · background'
          : ''
        : result.exit === 0
          ? ' ✓ exit 0'
          : result.exit === undefined || result.exit === null
            ? finished.failed
              ? ' × did not finish'
              : ''
            : ` × exit ${result.exit}`;
    const lines = (result.text ?? '')
      .replace(/\n+$/, '')
      .split('\n')
      .filter((l) => l.trim() !== '');
    return {
      state:
        finished && result.exit !== undefined && result.exit !== null && result.exit !== 0
          ? 'failed'
          : state,
      label: `Bash ${short(args.command)}${ended}`,
      tail: finished ? lines.slice(-tail).map((l) => short(l, 120)) : [],
      ...(result.text !== undefined ? { full: result.text.replace(/\n+$/, '') } : {}),
    };
  }
  return { state, label: humanTool(tool, input), tail: [] };
}

/** The verb the progress line shows for what the agent is doing now. */
export function activityVerb(running?: ToolLine): string {
  if (!running) return 'Thinking';
  if (running.label.startsWith('Edit ')) return 'Editing';
  if (running.label.startsWith('Bash ')) return 'Running ' + running.label.slice(5);
  return running.label;
}

const SPIN = ['◐', '◓', '◑', '◒'];
/** The live progress line while a turn runs: spinner, verb, elapsed seconds, tokens, interrupt hint. */
export function progressLine(
  verb: string,
  startedAt: number,
  now: number,
  tokens?: string,
): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return [
    SPIN[seconds % SPIN.length] + ' ' + safeText(verb) + '…',
    elapsed,
    ...(tokens ? [tokens + ' tokens'] : []),
    'esc to interrupt',
  ].join(' · ');
}
