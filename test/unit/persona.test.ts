import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadPersona, personaSection } from '../../src/persona.js';

// Item 9: the host's persona is an operator file, pinned by digest, appended last to the prompt.
// realpath: macOS /tmp is a symlink, and a persona path must be canonical.
const dir = () => realpathSync(mkdtempSync('/tmp/sal-persona-'));

test('a persona is a canonical, small, non-empty UTF-8 file, pinned by its content', () => {
  const d = dir();
  const p = join(d, 'persona.md');
  writeFileSync(p, 'Warm, brief, and plain-spoken.\n');
  const a = loadPersona(p);
  expect(a.text).toBe('Warm, brief, and plain-spoken.\n');
  expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(p, 'Formal.\n');
  expect(loadPersona(p).digest).not.toBe(a.digest);
  expect(() => loadPersona('persona.md')).toThrow('canonical absolute');
  symlinkSync(p, join(d, 'link.md'));
  expect(() => loadPersona(join(d, 'link.md'))).toThrow('canonical absolute');
  writeFileSync(p, 'x'.repeat(16 * 1024 + 1));
  expect(() => loadPersona(p)).toThrow('16 KiB');
  writeFileSync(p, Buffer.from([0xff, 0xfe, 0x41]));
  expect(() => loadPersona(p)).toThrow('UTF-8');
  writeFileSync(p, '  \n');
  expect(() => loadPersona(p)).toThrow('empty');
});

test('the persona section says it grants nothing and carries the operator text', () => {
  const s = personaSection({ text: 'Warm, brief.\n', digest: 'd' });
  expect(s).toContain('## Persona');
  expect(s).toContain('grants no tools, paths or permissions');
  expect(s.endsWith('Warm, brief.')).toBe(true);
});

// The worker side: house() appends the persona as the final prompt section, and only when set.
const saved = process.env.SALAAM_WORKER_CONFIG;
afterEach(() => {
  if (saved === undefined) delete process.env.SALAAM_WORKER_CONFIG;
  else process.env.SALAAM_WORKER_CONFIG = saved;
});
async function promptWith(persona?: { text: string; digest: string }) {
  process.env.SALAAM_WORKER_CONFIG = JSON.stringify({
    socket: '/nonexistent',
    token: 't',
    session: 's',
    epoch: 1,
    bundle: 'b',
    policy: 'p',
    frame: 'f',
    ...(persona ? { persona } : {}),
  });
  const handlers: ((e: unknown) => unknown)[] = [];
  const pi = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === 'on'
          ? (event: string, h: (e: unknown) => unknown) => {
              if (event === 'before_agent_start') handlers.push(h);
            }
          : () => undefined,
    },
  );
  const { default: house } = await import('../../src/house-extension.js');
  house(pi as never);
  let prompt = 'Base prompt.';
  for (const h of handlers) {
    const r = (await h({ type: 'before_agent_start', systemPrompt: prompt })) as
      { systemPrompt?: string } | undefined;
    if (r?.systemPrompt) prompt = r.systemPrompt;
  }
  return prompt;
}

test('a worker with the host persona ends its system prompt with it; without one, nothing changes', async () => {
  const withPersona = await promptWith({ text: 'Speak like a patient teacher.', digest: 'd' });
  expect(withPersona.startsWith('Base prompt.')).toBe(true);
  expect(withPersona.endsWith('Speak like a patient teacher.')).toBe(true);
  expect(await promptWith()).toBe('Base prompt.');
});

test('the daemon refuses a persona that changed since host plan, and gives workers the pinned one', async () => {
  const { SalaamService } = await import('../../src/service.js');
  const d = dir();
  const p = join(d, 'persona.md');
  writeFileSync(p, 'Warm.\n');
  const pinned = loadPersona(p);
  writeFileSync(p, 'Cold.\n');
  await expect(
    SalaamService.open({
      stateDir: join(d, 'a'),
      personaConfig: { config: p, digest: pinned.digest },
    }),
  ).rejects.toThrow('Host persona changed');
  writeFileSync(p, 'Warm.\n');
  const service = await SalaamService.open({
    stateDir: join(d, 'b'),
    personaConfig: { config: p, digest: pinned.digest },
  });
  try {
    expect(service.supervisor.persona).toEqual(pinned);
  } finally {
    await service.close();
  }
});
