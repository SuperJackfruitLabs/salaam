import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ToolkitControlProcess } from '../../src/toolkit-control-process.js';
import type { StdioProcessLaunch } from '../../src/mcp-stdio.js';

function fixture(mode = 'normal') {
  const dir = realpathSync(mkdtempSync('/tmp/stkcp-')),
    binary = join(dir, 'control-peer'),
    received = join(dir, 'received.json');
  writeFileSync(
    binary,
    `#!${realpathSync(process.execPath)}
import {createHash} from 'node:crypto';import {writeFileSync} from 'node:fs';
const mode=${JSON.stringify(mode)},received=${JSON.stringify(received)};
const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{
 const b=Buffer.concat(chunks),c=JSON.parse(b);writeFileSync(received,b);
 const result={version:1,control_digest:createHash('sha256').update(b).digest('hex'),root_revoked:true};
 if(mode==='hang')return setInterval(()=>{},1000);
 if(mode==='stdout')return process.stdout.write('x'.repeat(5000));
 if(mode==='stderr'){process.stderr.write('x'.repeat(5000));return setInterval(()=>{},1000);}
 if(mode==='malformed')return process.stdout.write('not-json');
 if(mode==='wrong-control')result.control_digest='f'.repeat(64);
 if(mode==='nonzero'){process.stdout.write(JSON.stringify(result));process.stderr.write('synthetic-private-diagnostic');return process.exit(7);}
 if(mode==='slow'){let i=0;return setInterval(()=>{process.stdout.write(' ');if(++i===200)process.stdout.write(JSON.stringify(result));},50);}
 process.stdout.write(JSON.stringify(result));
});
`,
    { mode: 0o700 },
  );
  const launch: StdioProcessLaunch = {
    command: binary,
    executable_digest: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    args: [
      'managed-control-v1',
      '--manifest',
      join(dir, 'manifest.json'),
      '--sha256',
      'a'.repeat(64),
    ],
    cwd: dir,
    env: { HOME: dir },
    limits: { request_bytes: 4096, response_bytes: 4096, stderr_bytes: 4096, timeout_ms: 1500 },
  };
  const control = {
    version: 1,
    action: 'revoke',
    root_digest: 'b'.repeat(64),
    profile_digest: 'c'.repeat(64),
    stop_proof_digest: 'd'.repeat(64),
    invocation_id: '',
    request_digest: '',
    decision_id: '',
  };
  return {
    dir,
    binary,
    received,
    launch,
    control,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('one-shot native control persists intent and actual PID before one stdin handoff and observes exit before return', async () => {
  const f = fixture();
  const phases: string[] = [];
  const child = new ToolkitControlProcess(
    f.launch,
    f.control,
    () => {
      expect(phases).toEqual(['intent', 'pid']);
      phases.push('send');
    },
    {
      starting: () => {
        phases.push('intent');
      },
      spawned: (pid) => {
        expect(pid).toBeGreaterThan(0);
        expect(existsSync(f.received)).toBe(false);
        phases.push('pid');
      },
    },
  );
  try {
    expect(await child.run()).toMatchObject({ version: 1, root_revoked: true });
    expect(child.stopped).toBe(true);
    expect(JSON.parse(readFileSync(f.received, 'utf8'))).toEqual(f.control);
    await expect(child.run()).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_control_unconfirmed' }),
    );
  } finally {
    await child.close();
    f.close();
  }
});

for (const mode of ['hang', 'slow', 'stdout', 'stderr', 'malformed', 'wrong-control', 'nonzero'])
  test(`control ${mode} never becomes successful and never retries`, async () => {
    const f = fixture(mode);
    let failures = 0;
    const child = new ToolkitControlProcess(f.launch, f.control, () => {}, {
      starting: () => {},
      spawned: () => {},
      failed: () => {
        failures++;
      },
    });
    try {
      await expect(child.run()).rejects.toThrowError(
        expect.objectContaining({ code: 'toolkit_control_unconfirmed' }),
      );
      expect(failures).toBe(1);
      expect(child.stopped).toBe(true);
      expect(JSON.parse(readFileSync(f.received, 'utf8'))).toEqual(f.control);
      await expect(child.run()).rejects.toThrow();
    } finally {
      await child.close();
      f.close();
    }
  });

for (const phase of ['intent', 'pid', 'send'])
  test(`asynchronous or failed ${phase} guard cannot deliver control bytes`, async () => {
    const f = fixture();
    const child = new ToolkitControlProcess(
      f.launch,
      f.control,
      () => {
        if (phase === 'send') throw Error('synthetic-private-diagnostic');
      },
      {
        starting: (() => (phase === 'intent' ? Promise.resolve() : undefined)) as () => void,
        spawned: (() => (phase === 'pid' ? Promise.resolve() : undefined)) as () => void,
      },
    );
    try {
      await expect(child.run()).rejects.toThrowError(
        expect.objectContaining({ code: 'toolkit_control_unconfirmed' }),
      );
      expect(existsSync(f.received)).toBe(false);
      expect(child.stopped).toBe(true);
    } finally {
      await child.close();
      f.close();
    }
  });

test('changed executable is refused before durable intent and no ambient provider environment is admitted', async () => {
  const f = fixture();
  let intents = 0;
  const hooks = {
    starting: () => {
      intents++;
    },
    spawned: () => {},
  };
  try {
    expect(
      () =>
        new ToolkitControlProcess(
          { ...f.launch, env: { HOME: f.dir, STK_PASSPHRASE: 'synthetic-only' } },
          f.control,
          () => {},
          hooks,
        ),
    ).toThrowError(expect.objectContaining({ code: 'toolkit_control_unconfirmed' }));
    const child = new ToolkitControlProcess(f.launch, f.control, () => {}, hooks);
    writeFileSync(f.binary, readFileSync(f.binary, 'utf8') + ' ');
    await expect(child.run()).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_control_unconfirmed' }),
    );
    expect(intents).toBe(0);
    expect(existsSync(f.received)).toBe(false);
  } finally {
    f.close();
  }
});

test('EPERM during stop observation retains presence until ESRCH without delivering guarded bytes', async () => {
  const f = fixture();
  const originalKill = process.kill.bind(process);
  let owned: number | undefined,
    observed = 0;
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -Number(owned) && signal === 0 && observed++ === 0)
      throw Object.assign(new Error('Process group remains present'), { code: 'EPERM' });
    return originalKill(pid, signal);
  });
  const child = new ToolkitControlProcess(f.launch, f.control, () => {}, {
    starting: () => {},
    spawned: ((pid: number) => {
      owned = pid;
      return Promise.resolve();
    }) as (pid: number) => void,
  });
  try {
    await expect(child.run()).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_control_unconfirmed' }),
    );
    expect(observed).toBeGreaterThan(1);
    expect(child.stopped).toBe(true);
    expect(existsSync(f.received)).toBe(false);
  } finally {
    kill.mockRestore();
    await child.close();
    f.close();
  }
});
