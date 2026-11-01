import { spawn } from 'node:child_process';
import type { DurableEvent } from '../core/protocol.js';

/** How the desk TUI gets a person's attention: off, a terminal bell, or a desktop notification
 * (which also rings the bell). Set with SALAAM_NOTIFY; the bell is the default. */
export type NotifyMode = 'off' | 'bell' | 'desktop';
export function notifyMode(env: NodeJS.ProcessEnv = process.env): NotifyMode {
  const v = env.SALAAM_NOTIFY;
  return v === 'off' || v === 'desktop' ? v : 'bell';
}

/** The events worth interrupting someone for, in plain words; everything else stays quiet. */
export function notificationFor(event: DurableEvent): string | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.kind === 'approval.requested') return 'Salaam is waiting for your approval';
  if (event.kind === 'attempt.completed') return 'Salaam finished the turn';
  if (event.kind === 'attempt.failed') return 'Salaam’s turn failed';
  if (event.kind === 'local.task_finished') {
    const how =
      p.state === 'exited'
        ? p.exit_code === 0
          ? 'finished'
          : `exited with ${String(p.exit_code)}`
        : String(p.state).replace('_', ' ');
    return `Background command ${how}: ${String(p.command ?? '').slice(0, 80)}`;
  }
  return null;
}

export function notify(
  message: string,
  mode: NotifyMode,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = detached,
  bell: (s: string) => void = (s) => void process.stdout.write(s),
): void {
  if (mode === 'off') return;
  bell('\x07');
  if (mode !== 'desktop') return;
  // Passed as an argument, never interpolated into the script: a command name cannot inject.
  if (platform === 'darwin')
    run('osascript', [
      '-e',
      'on run argv\ndisplay notification (item 1 of argv) with title "Salaam"\nend run',
      message,
    ]);
  else if (platform === 'linux') run('notify-send', ['Salaam', message]);
}
function detached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the bell already rang */
  }
}

export interface JobRow {
  id: string;
  command: string;
  state: string;
  exit_code: number | null;
  started_at: string;
}
export function jobsText(tasks: JobRow[], outputs: { output: string }[]): string {
  if (!tasks.length)
    return 'No background commands in this session.\nThe model starts one with salaam_local background: true.';
  return tasks
    .map((t, i) => {
      const state = t.state === 'exited' ? `exited ${String(t.exit_code)}` : t.state;
      const tail = outputs[i]?.output.split('\n').slice(-12).join('\n').trimEnd();
      return `${t.id}  ${state}  ${t.command}${tail ? '\n' + tail.replace(/^/gm, '  │ ') : ''}`;
    })
    .join('\n\n')
    .concat('\n\n/jobs stop <id> stops one.');
}
