import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  renameSync,
  fsyncSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

export function credentialPath(): string {
  return join(homedir(), '.config', 'salaam', 'credentials', 'anthropic');
}
export function validateApiKey(value: string): string {
  const key = value.trim();
  if (
    key.length < 12 ||
    key.length > 4096 ||
    /[^\x21-\x7e]/.test(key) ||
    key.includes('sk-ant-oat')
  )
    throw new Error('Supply a Claude API key, not an OAuth token');
  return key;
}
export function loadApiKey(path = credentialPath(), env = process.env.ANTHROPIC_API_KEY): string {
  if (env) return validateApiKey(env);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Claude API key missing. Run: salaam auth set anthropic');
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096
    )
      throw new Error(
        'Claude credential file must be owned by this user, mode 600 and at most 4096 bytes',
      );
    return validateApiKey(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
export function saveApiKey(value: string, path = credentialPath()): void {
  const key = validateApiKey(value),
    dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.anthropic-${randomUUID()}`),
    fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, key);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(dir, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4096) throw new Error('API key input too long');
    }
    return input;
  }
  process.stderr.write('Claude API key (hidden): ');
  const stdin = process.stdin,
    wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let key = '';
    const done = (error?: Error) => {
      stdin.off('data', data);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
      error ? reject(error) : resolve(key);
    };
    const data = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          done();
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          done(new Error('Credential entry cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          key = key.slice(0, -1);
          continue;
        }
        if (char.charCodeAt(0) >= 32) key += char;
        if (key.length > 4096) {
          done(new Error('API key input too long'));
          return;
        }
      }
    };
    stdin.on('data', data);
  });
}
