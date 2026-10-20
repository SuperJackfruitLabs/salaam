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

// Producer publishes every default explicitly. Consumer normalization must not
// silently alter the admitted digest before durable task creation.
import { TaskWork } from '../../src/task-work.js';
import { digest } from '../../src/protocol.js';
const payloads = JSON.parse(
  readFileSync(new URL('../fixtures/agentpod-work-payload-v1.json', import.meta.url), 'utf8'),
);
for (const sample of payloads.cases)
  test(`owner payload normalization: ${sample.name}`, () => {
    const plan = TaskWork.prototype.parse(sample.payload.plan);
    expect(plan).toEqual(sample.payload.plan);
    expect(digest(plan)).toBe(sample.payload.admission.work.plan_digest);
    expect(digest(sample.payload.input)).toBe(sample.payload.admission.work.input_digest);
  });
