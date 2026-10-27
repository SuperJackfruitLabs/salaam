import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, create, ready, until } from '../helpers.js';
import { submit } from '../managed-helpers.js';
import { ROOT } from '../../src/config.js';
import { loadPersona } from '../../src/persona.js';

// Item 9 proof: a real pinned Pi worker on a host with a persona sends it as the last section of
// its system prompt, and attests the persona digest the host pinned.
test('a real Pi worker carries the host persona in its prompt and attests its digest to become ready', async () => {
  const d = mkdtempSync('/tmp/sal-persona-proof-');
  const file = join(d, 'persona.md');
  writeFileSync(file, 'PERSONA-MARKER: speak like a patient teacher.\n');
  const persona = loadPersona(file);
  const f = await fixture({
    extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs'),
    personaConfig: { config: file, digest: persona.digest },
  });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    expect(f.service.supervisor.inspect(session.id).state).toBe('ready');
    await submit(f.service, session.id, 'Say hello.');
    await until(
      () => f.service.store.snapshot(session.id).attempts,
      (as) => ['completed', 'failed', 'interrupted'].includes(as[0]?.state ?? ''),
    );
    const payloads = readFileSync(join(f.dir, 'task-payloads.jsonl'), 'utf8');
    expect(payloads).toContain('PERSONA-MARKER: speak like a patient teacher.');
    expect(payloads).toContain('grants no tools, paths or permissions');
    // Readiness itself is the attestation: the worker reported the pinned persona digest, which
    // the supervisor compares to the one it launched with (a mismatch never becomes ready).
  } finally {
    await f.close();
  }
});
