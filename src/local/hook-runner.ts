// Spawning a hook: its JSON on stdin, a minimal environment, bounded output and a timeout. The
// caller has chosen the sandbox and built the argv.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { COMMAND_PATH } from './command-launch.js';
import type { HookRun } from './hooks.js';

/** Most bytes of output a hook may give on each stream. */
const HOOK_OUTPUT_LIMIT = 16 * 1024;

export function spawnHook(
  argv: string[],
  root: string,
  input: string,
  timeoutMs: number,
  tmp: string | undefined,
): Promise<HookRun> {
  return new Promise<HookRun>((resolve) => {
    let stdout = '',
      stderr = '',
      truncated = false,
      timedOut = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: root,
      detached: true,
      env: {
        PATH: COMMAND_PATH,
        HOME: process.env.HOME ?? root,
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp',
        SALAAM_PROJECT_DIR: root,
        CLAUDE_PROJECT_DIR: root,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const take = (current: string, chunk: Buffer) => {
      const room = HOOK_OUTPUT_LIMIT - Buffer.byteLength(current);
      if (chunk.length > room) truncated = true;
      return room > 0 ? current + chunk.subarray(0, room).toString('utf8') : current;
    };
    child.stdout.on('data', (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = take(stderr, c)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, truncated });
    };
    child.once('error', (error) => {
      stderr = take(stderr, Buffer.from(error.message));
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}
