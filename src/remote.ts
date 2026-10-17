import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface RemoteOptions {
  host: string;
  executable?: string;
  state?: string;
  session?: string;
  observe?: boolean;
  takeover?: boolean;
  theme?: 'night' | 'paper';
}
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function remoteArguments(options: RemoteOptions): string[] {
  if (!/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9._:[\]-]*$/.test(options.host))
    throw new Error('Use a configured SSH alias or a host name.');
  if (options.observe && options.takeover)
    throw new Error('Choose either --observe or --takeover.');
  const executable = options.executable ?? 'sal';
  if (
    !executable ||
    /[\x00-\x1f\x7f]/.test(executable) ||
    (executable !== 'sal' && !isAbsolute(executable))
  )
    throw new Error('--remote-bin must be an absolute installed Salaam executable.');
  if (options.state && (!isAbsolute(options.state) || /[\x00-\x1f\x7f]/.test(options.state)))
    throw new Error('--state must be an absolute path on the execution host.');
  if (options.session && !/^[a-f0-9-]{36}$/i.test(options.session))
    throw new Error('Use the saved session UUID.');
  const command = [
    executable,
    'tui',
    ...(options.state ? ['--state', options.state] : []),
    ...(options.session ? ['--session', options.session] : []),
    ...(options.observe ? ['--observe'] : []),
    ...(options.takeover ? ['--takeover'] : []),
    ...(options.theme ? ['--theme', options.theme] : []),
  ];
  return [
    '-t',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '--',
    options.host,
    command.map(shellQuote).join(' '),
  ];
}
export async function remote(options: RemoteOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Remote TUI needs a terminal. Use ssh with the scriptable Salaam commands for automation.',
    );
  const child = spawn('ssh', remoteArguments(options), { stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            'SSH session ended ' +
              (signal ?? `with status ${code}`) +
              '. Reconnect to the same session to inspect work.',
          ),
        );
    });
  });
}
