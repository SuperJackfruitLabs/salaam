import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultAgentPodConfig } from '../../src/agentpod/default-config.js';

describe('default AgentPod pins', () => {
  it('uses the per-user pins file when it exists', () => {
    const seen: string[] = [];
    const exists = (p: string) => (seen.push(p), true);
    expect(defaultAgentPodConfig({ HOME: '/home/u' }, exists)).toBe(
      '/home/u/.config/salaam/agentpod-pins.json',
    );
    expect(defaultAgentPodConfig({ HOME: '/home/u', XDG_CONFIG_HOME: '/cfg' }, exists)).toBe(
      '/cfg/salaam/agentpod-pins.json',
    );
  });
  it('stays unbound without one', () => {
    expect(defaultAgentPodConfig({ HOME: '/home/u' }, () => false)).toBeUndefined();
  });
  it('is what service start falls back to', () => {
    const cli = readFileSync(new URL('../../src/cli/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(
      /option\('--agentpod-config'\)\s*\?\?\s*defaultAgentPodConfig\(process\.env, existsSync\)/,
    );
  });
});
