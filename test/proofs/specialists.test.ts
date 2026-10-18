import { expect, test } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskFixture } from '../task-helpers.js';
import { submit } from '../managed-helpers.js';
import { until } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { digest } from '../../src/protocol.js';
import { parseAgentProfile } from '../../src/agent-profiles.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { DEFAULT_CLAUDE_MODEL } from '../../src/provider-config.js';

const extensionPath = join(ROOT, 'test/fixtures/specialist-extension.mjs');
test('profiles reject executable, credential, plugin and excess tool authority', () => {
  for (const metadata of [
    { role: 'explorer', command: 'sh' },
    { role: 'reviewer', env: { TOKEN: 'fixture' } },
    { role: 'explorer', tools: ['salaam_command'] },
    { role: 'explorer', max_depth: 2 },
    { role: 'explorer', max_requests: 9 },
    { role: 'explorer', provider: 'anthropic' },
  ]) {
    expect(() =>
      parseAgentProfile('custom', `---\n${JSON.stringify(metadata)}\n---\nInspect the repository.`),
    ).toThrow();
  }
});
test('real native explorer and reviewer return frozen file/line evidence and stable analysis across daemon restart', async () => {
  const f = await taskFixture({ extensionPath });
  try {
    const workspace = f.service.workspaces.get(f.session.id);
    writeFileSync(join(workspace.root, 'app.js'), 'export const answer = 41;\n');
    const observed = f.service.workspaces.inspect(f.session.id) as { observed_digest: string };
    f.service.workspaces.refresh(
      f.session.id,
      'human',
      workspace.revision,
      observed.observed_digest,
      () => {},
    );
    for (const id of ['salaam/explorer', 'salaam/reviewer']) {
      const p = f.service.agents.inspect(f.session.id, id);
      await f.service.agents.admit(f.session.id, randomUUID(), id, digest(p), [], f.actor);
    }
    await submit(f.service, f.session.id, '[children] explorer,reviewer');
    const children = await until(
      () => f.service.children.list(f.session.id),
      (cs) => cs.length === 2 && cs.every((c) => c.state === 'completed'),
    );
    for (const child of children) {
      expect(child.worker!.binding.tools).toContain('salaam_repository');
      expect(child.worker!.binding.tools).not.toContain('salaam_files');
      const evidence = readFileSync(join(f.source, 'evidence-' + child.child_session), 'utf8');
      expect(evidence).toContain('export const answer = 41;');
      expect(evidence).toContain('"line":1');
      expect(evidence).toContain('"hash"');
      expect(() =>
        f.service.repositories.read(child.worker!.binding, {
          action: 'patch',
          path: 'app.js',
          content: 'overwrite',
        }),
      ).toThrow('only');
      expect(() =>
        f.service.repositories.read(child.worker!.binding, { action: 'read', path: '.env' }),
      ).toThrow('Credential');
      expect(() =>
        f.service.repositories.read(child.worker!.binding, { action: 'read', path: '../app.js' }),
      ).toThrow('relative');
    }
    const review = children.find((c) => c.worker!.binding.profile.role === 'reviewer')!;
    const report = f.service.store.db
      .prepare('SELECT artifact_id FROM specialist_reports WHERE worker_id=?')
      .get(review.worker!.binding.worker_id)!;
    expect(JSON.parse(f.service.artifacts.read(String(report.artifact_id)))).toMatchObject({
      kind: 'analysis',
      findings: [{ path: 'app.js', line: 1, evidence: 'export const answer = 41;' }],
    });
    writeFileSync(join(workspace.root, 'app.js'), 'human changed after the snapshot\n');
    expect(
      JSON.stringify(
        f.service.repositories.read(review.worker!.binding, { action: 'read', path: 'app.js' }),
      ),
    ).toContain('answer = 41');
    const before = f.service.children.consume(f.session.id, review.id, review.result_id!);
    await f.restart();
    expect(f.service.children.consume(f.session.id, review.id, review.result_id!)).toEqual(before);
    expect(f.service.children.list(f.session.id)).toHaveLength(2);
    expect(readFileSync(join(workspace.root, 'app.js'), 'utf8')).toBe(
      'human changed after the snapshot\n',
    );
  } finally {
    await f.close();
  }
});
test('project profile discovery grants no authority; a changed file fences an admitted running specialist', async () => {
  const f = await taskFixture({ extensionPath });
  try {
    const directory = join(f.source, '.salaam/agents');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'custom.md');
    writeFileSync(
      file,
      '---\n{"role":"explorer","revision":1}\n---\nUse only selected facts and snapshot evidence.',
    );
    const profile = f.service.agents.inspect(f.session.id, 'project/custom');
    expect(() => f.service.agents.resolve(f.session.id, profile.id)).toThrow('Operator');
    const request = 'admit',
      grant = await f.service.agents.admit(
        f.session.id,
        request,
        profile.id,
        digest(profile),
        [],
        f.actor,
      );
    f.service.store.db
      .prepare('UPDATE controls SET expires_at=0 WHERE session_id=?')
      .run(f.session.id);
    expect(
      await f.service.agents.admit(f.session.id, request, profile.id, digest(profile), [], f.actor),
    ).toEqual(grant);
    writeFileSync(join(f.source, 'hold-specialists'), 'hold');
    await submit(f.service, f.session.id, '[children] project-custom');
    const child = await until(
      () => f.service.children.list(f.session.id)[0],
      (c) => !!c && existsSync(join(f.source, 'evidence-' + c.child_session)),
    );
    const prompt = f.service.store.db
      .prepare('SELECT text FROM submissions WHERE attempt_id=?')
      .get(child!.child_attempt)!;
    expect(String(prompt.text)).toContain('Explicitly selected facts:\n[]');
    writeFileSync(
      file,
      '---\n{"role":"explorer","revision":2}\n---\nChanged context must be newly admitted.',
    );
    await until(
      () => f.service.children.inspect(f.session.id, child!.id),
      (c) => c.state === 'interrupted',
    );
    expect(f.service.supervisor.inspect(child!.child_session).state).not.toBe('ready');
    expect(f.service.children.list(f.session.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a native parent delegates to a separately admitted provider without changing its own route or leaking parent facts', async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('anthropic', async () => ({
    type: 'api_key',
    key: 'fixture-anthropic-key',
  }));
  const f = await taskFixture({
    extensionPath: join(ROOT, 'test/fixtures/routed-specialist-extension.mjs'),
    providerCredentials: credentials,
    providerEnvironment: {},
  });
  let mock: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(join(f.source, 'provider-api'), 'anthropic-messages');
    writeFileSync(join(f.source, 'provider-mode'), 'tool');
    mock = spawn(process.execPath, [join(ROOT, 'test/fixtures/mock-provider.mjs'), f.source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await once(mock.stdout!, 'data');
    mkdirSync(join(f.source, '.salaam/agents'), { recursive: true });
    writeFileSync(
      join(f.source, '.salaam/agents/claude.md'),
      `---\n${JSON.stringify({ revision: 1, role: 'explorer', provider: 'anthropic', model: DEFAULT_CLAUDE_MODEL })}\n---\nInvestigate the snapshot only.`,
    );
    const fact = f.service.tasks.update(
      f.session.id,
      'private-fact',
      0,
      { kind: 'constraint', text: 'PRIVATE PARENT FACT MUST NOT BE SHARED' },
      () => f.service.store.authorizeControl(f.session.id, f.actor),
    );
    expect(fact.facts).toHaveLength(1);
    const profile = f.service.agents.inspect(f.session.id, 'project/claude');
    await f.service.agents.admit(f.session.id, 'grant', profile.id, digest(profile), [], f.actor);
    await submit(f.service, f.session.id, '[children] project-claude');
    const child = await until(
      () => f.service.children.list(f.session.id)[0],
      (c) => c?.state === 'completed',
      20000,
    );
    expect(child!.worker!.binding.route!.provider).toBe('anthropic');
    expect(f.service.store.providerRoute(f.session.id)!.provider).toBe('salaam-proof');
    const payload = readFileSync(join(f.source, 'provider-payload'), 'utf8');
    expect(payload).not.toContain('PRIVATE PARENT FACT');
    expect(payload).toContain('salaam_repository');
    expect(f.service.store.usage.summary(f.session.id)).toMatchObject({ unknown_observations: 0 });
  } finally {
    await f.close();
    if (mock && mock.exitCode === null && mock.signalCode === null) {
      const exit = once(mock, 'exit');
      mock.kill('SIGKILL');
      await exit;
    }
  }
}, 30000);
