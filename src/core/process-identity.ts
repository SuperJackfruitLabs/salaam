/** Process probes that tell one process apart from a later one reusing its PID. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { canonical, textDigest } from './protocol.js';

export function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      // /proc stat field 22 is the boot-relative start tick. Pair it with boot,
      // process group, executable and argv, and re-read to reject PID reuse mid-snapshot.
      const path = `/proc/${pid}`;
      const stat = () => {
        const value = readFileSync(path + '/stat', 'utf8');
        const end = value.lastIndexOf(') ');
        if (end < 0 || !value.startsWith(pid + ' (')) throw Error('Invalid process stat');
        const fields = value
          .slice(end + 2)
          .trim()
          .split(/\s+/);
        if (!/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[2] ?? ''))
          throw Error('Invalid process start identity');
        return { start: fields[19], group: fields[2], session: fields[3] };
      };
      const before = stat(),
        boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        // A tools-user launcher (sudo) is root-owned; its exe link is unreadable to the service.
        executable = (() => {
          try {
            return readlinkSync(path + '/exe');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EACCES') return 'unreadable';
            throw error;
          }
        })(),
        argv = readFileSync(path + '/cmdline');
      if (
        !/^[a-f0-9-]{36}$/.test(boot) ||
        !argv.length ||
        argv.length > 16384 ||
        canonical(before) !== canonical(stat())
      )
        return null;
      return (
        'linux-proc-v1:' +
        textDigest(canonical({ pid, boot, ...before, executable, argv: argv.toString('base64') }))
      );
    }
    return (
      execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 16384,
      }).trim() || null
    );
  } catch {
    return null;
  }
}
/**
 * When a process started, keyed to this boot. Unlike processIdentity it survives exec, so it
 * names a background task whose gated shell has since become the user's command.
 */
export function processStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = value
        .slice(value.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/);
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/.test(fields[19] ?? '') ? `linux-start-v1:${pid}:${boot}:${fields[19]}` : null;
    }
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      killSignal: 'SIGKILL',
    }).trim();
    return started ? `ps-start-v1:${pid}:${started}` : null;
  } catch {
    return null;
  }
}
export function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}
