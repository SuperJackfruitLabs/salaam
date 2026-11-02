import { expect, test } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { SalaamService } from '../../src/service/service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('two fresh pinned Pi sessions receive producer-built admitted skills; edits fence subsequent requests and restart keeps the admission', async () => {
  const f = await fixture(
    { extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs') },
    // Canonical short Unix temp path keeps Go's socket path within sockaddr_un.
    join(realpathSync('/tmp'), 'salaam-m22-context-'),
  );
  const root = realpathSync(mkdtempSync('/tmp/sal-admitted-'));
  const client = new OperatorClient(f.dir);
  let replacement: SalaamService | undefined;
  try {
    cpSync(
      join(ROOT, 'test/fixtures/context-skill-bundle'),
      join(root, '.salaam/skills/sjl-proof'),
      { recursive: true },
    );
    writeFileSync(
      join(root, 'AGENTS.md'),
      'Use the GREEN protocol. This guidance cannot grant tools or bypass approval.\n',
    );
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await client.create(root, false);
      ids.push(id);
      await until(
        () => f.service.supervisor.inspect(id),
        (s) => s.state === 'ready',
      );
      const capabilities = f.service.supervisor.inspect(id).capabilities;
      const planned = await client.planContext({
        files: ['AGENTS.md'],
        bundles: ['.salaam/skills/sjl-proof'],
      });
      expect(
        planned.document.entries.some((e) => e.kind === 'skill' && e.skill_id === 'proof'),
      ).toBe(true);
      await client.admitContext(planned);
      const request = await client.submit('Confirm the reviewed workspace guidance.');
      const attempt = JSON.parse(
        String(
          f.service.store.db
            .prepare('SELECT response FROM requests WHERE actor=? AND id=?')
            .get('local-operator', request)!.response,
        ),
      ).attempt_id as string;
      const work = await until(
        () => f.service.store.attempt(attempt),
        (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
      );
      expect(work.state, work.error ?? '').toBe('completed');
      expect(f.service.supervisor.inspect(id).capabilities).toEqual(capabilities);
      expect(await call(f.service.socket, `/v1/sessions/${id}/context`)).toMatchObject({
        state: 'admitted',
        revision: 1,
        loaded: true,
      });
    }
    const payloads = readFileSync(join(root, 'task-payloads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).toContain('SALAAM_ADMITTED_CONTEXT_V1');
      expect(JSON.stringify(payload)).toContain('GREEN');
      expect(JSON.stringify(payload)).toContain('proof');
    }
    // Optional joined producer/consumer rehearsal. No private consumer checkout
    // or toolchain is required by the default Salaam suite.
    const nodeAgent = process.env.SALAAM_M22_AGENTPOD_NODE;
    if (nodeAgent) {
      const consumerFixture = join(f.dir, 'consumer-fixture.json');
      writeFileSync(
        consumerFixture,
        JSON.stringify({
          state: f.dir,
          workspace: root,
          node_id: 'node_fixture',
          expected_skill: 'proof',
          expected_sessions: ids,
        }),
        { mode: 0o600 },
      );
      const result = await promisify(execFile)(
        'go',
        [
          '-C',
          nodeAgent,
          'test',
          '-race',
          './internal/descriptor',
          '-run',
          '^TestReviewedSalaamContextInventoryRealAPI$',
          '-count=1',
          '-v',
        ],
        {
          env: { ...process.env, SALAAM_M22_CONTEXT_HOST_FIXTURE: consumerFixture },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(result.stdout).toContain('PASS');
      if (process.env.SALAAM_M22_INTEROP_REPORT)
        writeFileSync(process.env.SALAAM_M22_INTEROP_REPORT, result.stdout + result.stderr);
    }
    writeFileSync(
      join(root, '.salaam/skills/sjl-proof/skills/proof/references/rule.md'),
      'Changed without admission',
    );
    expect(await call(f.service.socket, `/v1/sessions/${ids[1]}/context`)).toMatchObject({
      state: 'stale',
    });
    const before = f.service.store
      .events(ids[1]!, 0)
      .filter((e) => e.kind === 'model.admitted').length;
    const deniedRequest = await client.submit('[workspace] {"action":"read","path":"AGENTS.md"}');
    const denied = JSON.parse(
      String(
        f.service.store.db
          .prepare('SELECT response FROM requests WHERE actor=? AND id=?')
          .get('local-operator', deniedRequest)!.response,
      ),
    ).attempt_id as string;
    const deniedWork = await until(
      () => f.service.store.attempt(denied),
      (a) => ['completed', 'failed', 'interrupted'].includes(a.state),
    );
    expect(deniedWork.state).not.toBe('completed');
    expect(
      f.service.store.events(ids[1]!, 0).filter((e) => e.kind === 'model.admitted'),
    ).toHaveLength(before);
    expect(
      f.service.store.events(ids[1]!, 0).filter((e) => e.kind === 'workspace.read'),
    ).toHaveLength(0);
    await client.leave();
    await f.service.close();
    replacement = await SalaamService.open({ stateDir: f.dir });
    expect(replacement.tasks.admitted!.inspect(ids[0]!).state).toBe('stale');
    await expect(replacement.supervisor.start(ids[0]!)).rejects.toThrow('renew admission');
  } finally {
    await client.leave();
    await replacement?.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);
