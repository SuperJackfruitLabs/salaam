import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { probeHarness } from '../../src/harness-probe.js';

test('operator capability probe has an empty credential home and never promotes advertised tools to authority', async () => {
  const dir = mkdtempSync('/tmp/sal-harness-pin-'),
    executable = join(dir, 'agent');
  const code = `#!${process.execPath}\nimport fs from 'node:fs';import{createInterface}from'node:readline';if(process.argv.includes('--version')){console.log('0.64.0');process.exit(0)}for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.method!=='initialize')throw Error('unexpected task dispatch');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false,files:true,commands:true},inheritedSecret:Boolean(process.env.ANTHROPIC_API_KEY),hasUserConfig:fs.existsSync(process.env.HOME+'/.private-fixture'),client:m.params.clientCapabilities}})+'\\n');}`;
  try {
    writeFileSync(executable, code, { mode: 0o700 });
    const pin = {
      target: 'gemini-acp' as const,
      executable,
      version: '0.64.0',
      executable_digest: createHash('sha256').update(code).digest('hex'),
    };
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'fixture-secret-never-forward';
    try {
      const result = await probeHarness(pin);
      expect(result.advertised).toMatchObject({
        protocolVersion: 1,
        inheritedSecret: false,
        hasUserConfig: false,
        client: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      expect(result.enforced).toMatchObject({
        files: false,
        commands: false,
        model_requests: false,
        isolation: 'unproven',
      });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
    writeFileSync(executable, code + '\n// changed');
    await expect(probeHarness(pin)).rejects.toMatchObject({ code: 'harness_pin_changed' });
    await expect(probeHarness({ ...pin, version: '0.64.1' })).rejects.toMatchObject({
      code: 'harness_pin_changed',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
