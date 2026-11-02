import { expect, test } from 'vitest';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, fake, ready, until } from '../helpers.js';
import { effectFixture } from '../managed-helpers.js';
import { call } from '../../src/core/transport.js';
import { ROOT } from '../../src/core/config.js';
import type { Launch } from '../../src/runtime/supervisor.js';
import type { ServiceOptions } from '../../src/service/service.js';
import type { Session } from '../../src/core/protocol.js';

// Phase 4 (modularity): the Pi launch the supervisor builds (argv, cwd and environment, including
// the worker configuration the house extension reads) is pinned for representative sessions, so
// moving launch building out of start() cannot change a byte of it. Values that differ per run
// (paths, ids, tokens, digests of the build) are replaced by names; everything else is compared.

/** The host values the launch passes through from the service's own environment. */
const INHERITED: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG ?? 'en_US.UTF-8',
};

function normalize(launch: Launch, known: Record<string, string>): unknown {
  const config: unknown = JSON.parse(String(launch.env.SALAAM_WORKER_CONFIG));
  const env: Record<string, unknown> = { ...launch.env, SALAAM_WORKER_CONFIG: config };
  for (const [key, value] of Object.entries(INHERITED))
    if (key in env && env[key] === value) env[key] = `<${key}>`;
  let text = JSON.stringify({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env,
    env_keys: Object.keys(launch.env),
    // The exact string Pi receives, so key order and spacing are pinned too.
    config_text: launch.env.SALAAM_WORKER_CONFIG,
  });
  const replace = (value: string | undefined, name: string) => {
    if (value) text = text.split(value).join(name);
  };
  for (const [value, name] of Object.entries(known)) replace(value, name);
  replace(ROOT, '<root>');
  replace(process.execPath, '<node>');
  return JSON.parse(text.replace(/[a-f0-9]{64}/g, '<hex64>').replace(/[a-f0-9]{32}/g, '<hex32>'));
}

async function launches(options: Partial<ServiceOptions>, body: Record<string, unknown> = {}) {
  const seen: Launch[] = [];
  // Once set, a launch is recorded and refused, so start() stops right after building it.
  const only = { capture: false };
  const base = fake().launch;
  if (!base) throw new Error('fake() has no launch');
  const f = await fixture({
    ...fake(),
    ...options,
    launch: (launch) => {
      seen.push(structuredClone(launch));
      if (only.capture) throw new Error('launch captured');
      return base(launch);
    },
  });
  const session = await call<Session>(f.service.socket, '/v1/sessions', {
    request_id: 'create',
    cwd: f.dir,
    ...body,
  });
  await until(
    () => seen.length,
    (n) => n > 0,
  );
  return { f, session, seen, only };
}

function names(f: { dir: string; service: { supervisor: { bootId: string } } }, id: string) {
  return {
    // The real path first: on macOS /tmp is a link to /private/tmp.
    [realpathSync(f.dir)]: '<state>',
    [f.dir]: '<state>',
    [id]: '<session>',
    [f.service.supervisor.bootId]: '<boot>',
  };
}

test('a plain offline session launches Pi with the pinned argv and environment', async () => {
  const { f, session, seen } = await launches({});
  try {
    await ready(f.service, session.id);
    expect(seen.map((x) => normalize(x, names(f, session.id)))).toMatchSnapshot();
  } finally {
    await f.close();
  }
});

test('a restarted session resumes its recorded Pi transcript', async () => {
  const { f, session, seen, only } = await launches({});
  try {
    await ready(f.service, session.id);
    const file = f.service.store.session(session.id).pi_session_file;
    if (!file) throw new Error('no session file recorded');
    writeFileSync(file, '');
    await f.service.supervisor.stopSession(session.id);
    only.capture = true;
    await expect(f.service.supervisor.start(session.id)).rejects.toThrow('launch captured');
    expect(seen).toHaveLength(2);
    expect(seen.map((x) => normalize(x, names(f, session.id)))).toMatchSnapshot();
  } finally {
    await f.close();
  }
});

test('effects, a persona and local sessions change the launch as recorded', async () => {
  const external = await effectFixture();
  const personaFile = join(realpathSync(external.dir), 'persona.md');
  writeFileSync(personaFile, 'Speak plainly.\n');
  const { loadPersona } = await import('../../src/runtime/persona.js');
  const persona = { config: personaFile, digest: loadPersona(personaFile).digest };
  const cases: [string, Partial<ServiceOptions>, Record<string, unknown>][] = [
    ['effects', { effectConnector: external.connector }, {}],
    ['persona', { personaConfig: persona }, {}],
    ['local workspace', {}, { local_workspace: true }],
    ['local coding', {}, { local_workspace: true, local_coding: true }],
  ];
  const out: Record<string, unknown> = {};
  try {
    for (const [name, options, body] of cases) {
      const { f, session, seen } = await launches(options, body);
      try {
        out[name] = seen.map((x) =>
          normalize(x, {
            ...names(f, session.id),
            [realpathSync(external.dir)]: '<external>',
            [external.dir]: '<external>',
          }),
        );
      } finally {
        await f.close();
      }
    }
  } finally {
    await external.close();
  }
  expect(out).toMatchSnapshot();
});
