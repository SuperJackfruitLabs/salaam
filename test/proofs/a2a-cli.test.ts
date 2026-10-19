import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sdkPeer } from '../fixtures/a2a-peer.js';
import { ROOT } from '../../src/config.js';
import { digest } from '../../src/protocol.js';

test('operator CLI creates credentials without exposing/overwriting them and discovers/pins only the configured peer', async () => {
  const f = await sdkPeer(),
    exec = promisify(execFile);
  const env: NodeJS.ProcessEnv = { HOME: f.dir, PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  const run = (...args: string[]) =>
    exec(process.execPath, [join(ROOT, 'bin/salaam.mjs'), 'a2a', ...args], {
      cwd: f.dir,
      env,
      timeout: 15000,
      maxBuffer: 1048576,
    });
  try {
    const file = join(f.dir, 'new-peer.json'),
      created = await run('credential', 'new-peer', '--file', file),
      credential = JSON.parse(readFileSync(file, 'utf8'));
    expect(credential.peer).toBe('new-peer');
    expect(credential.token).toHaveLength(43);
    expect(created.stdout).not.toContain(credential.token);
    expect(statSync(file).mode & 0o077).toBe(0);
    await expect(run('credential', 'new-peer', '--file', file)).rejects.toThrow();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(credential);
    const args = [
      '--peer',
      'sdk',
      '--endpoint',
      f.peer.endpoint,
      '--card-url',
      f.peer.card_url,
      '--credential-file',
      f.peer.credential_file,
      '--addresses',
      '127.0.0.1',
      '--local',
    ];
    const discovered = await run('discover', ...args),
      card = JSON.parse(discovered.stdout),
      cardFile = join(f.dir, 'card.json');
    expect(digest(card)).toBe(f.peer.card_digest);
    writeFileSync(cardFile, discovered.stdout);
    const pin = JSON.parse(
      (
        await run(
          'pin',
          ...args,
          '--card-file',
          cardFile,
          '--skill',
          'review',
          '--tenant',
          'tenant-a',
          '--files',
          'app.js',
        )
      ).stdout,
    );
    expect(pin).toMatchObject({
      card_digest: f.peer.card_digest,
      credential_digest: f.peer.credential_digest,
      files: ['app.js'],
    });
    expect(JSON.stringify(pin)).not.toContain(f.token);
    await expect(
      run(
        'pin',
        ...args,
        '--card-file',
        cardFile,
        '--skill',
        'unadvertised',
        '--tenant',
        'tenant-a',
      ),
    ).rejects.toThrow();
    expect(f.accepted).toBe(0);
  } finally {
    await f.close();
  }
});
