import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  agentpodWorkAdmission,
  checkAgentPodWorkAdmission,
  checkAgentPodWorkReplay,
} from '../../src/agentpod-work-protocol.js';
const corpus = JSON.parse(
  readFileSync(new URL('../fixtures/agentpod-work-v1.json', import.meta.url), 'utf8'),
);
for (const sample of corpus.admissions)
  test(`owner corpus shape: ${sample.name}`, () => {
    if (sample.accept) expect(() => agentpodWorkAdmission(sample.value)).not.toThrow();
    else expect(() => agentpodWorkAdmission(sample.value)).toThrow();
  });
for (const sample of corpus.bindings)
  test(`owner corpus binding: ${sample.name}`, () => {
    const result = checkAgentPodWorkAdmission(sample.value, sample.expected);
    expect(result.ok ? 'accepted' : result.code).toBe(sample.result);
  });
for (const sample of corpus.replays)
  test(`owner corpus replay: ${sample.name}`, () => {
    const result = checkAgentPodWorkReplay(sample.value, sample.saved);
    expect(result.ok ? 'replay' : result.code).toBe(sample.result);
  });
