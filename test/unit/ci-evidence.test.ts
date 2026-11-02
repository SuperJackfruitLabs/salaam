import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../src/core/config.js';

const planUrl = pathToFileURL(join(ROOT, 'scripts/ci-plan.mjs')).href;
const evidenceUrl = pathToFileURL(join(ROOT, 'scripts/ci-evidence.mjs')).href;
const sourceUrl = pathToFileURL(join(ROOT, 'scripts/release-source.mjs')).href;
const { acceptancePlan, hash, proofs, portfolios } = await import(planUrl);
const { collectEvidence, validateCertificate } = await import(evidenceUrl);
const { privateRuntimeImage } = await import(
  pathToFileURL(join(ROOT, 'scripts/runtime/receipt.mjs')).href
);
const { trustedMainRun, selectCertificateArtifact, findMainRun, validatePromotion } = await import(
  sourceUrl
);

function fixture(profile = 'full') {
  const dir = mkdtempSync('/tmp/sal-ci-evidence-');
  const sources = [{ path: 'test/unit/fixture.test.ts', sha256: 'a'.repeat(64) }];
  const pin = { version: '1.3.0' };
  const expected = {
    repository: 'SuperJackfruitLabs/salaam',
    commit: 'f'.repeat(40),
    source_digest: hash(JSON.stringify(sources)),
    node: 'v26.7.0',
    npm: 'npm@11.19.0',
    pin_digest: hash(JSON.stringify(pin)),
    version: '0.0.2',
    package: '@superjackfruitlabs/salaam',
    run_id: '123',
    run_attempt: 1,
  };
  const metadata = {
    commit: expected.commit,
    dirty: false,
    version: expected.version,
    tag: 'v0.0.2',
    node: '26.7.0',
    npm: expected.npm,
    package: expected.package,
    pin,
    package_sha256: hash('fixture tarball'),
  };
  const packageDirectory = join(dir, 'package');
  mkdirSync(packageDirectory);
  writeFileSync(join(packageDirectory, 'salaam-cli-0.0.2.tgz'), 'fixture tarball');
  writeFileSync(join(packageDirectory, 'release.json'), JSON.stringify(metadata));
  writeFileSync(join(packageDirectory, 'install.sh'), 'fixture installer');
  writeFileSync(
    join(packageDirectory, 'SHA256SUMS'),
    ['salaam-cli-0.0.2.tgz', 'release.json', 'install.sh']
      .map((name) => `${hash(readFileSync(join(packageDirectory, name)))}  ${name}\n`)
      .join(''),
  );
  const manifests: any[] = [],
    receipts: any[] = [];
  for (const platform of ['linux', 'darwin']) {
    for (let slot = 0; slot <= (profile === 'full' ? 4 : 0); slot++) {
      const kind = slot ? 'proofs' : profile === 'full' ? 'baseline' : 'quick';
      const plan = acceptancePlan(['--profile', kind, ...(slot ? ['--shard', `${slot}/4`] : [])]);
      const directory = join(dir, platform, String(slot));
      mkdirSync(directory, { recursive: true });
      const d: any = {
        schema_version: 2,
        profile: kind,
        shard: plan.shard,
        proof_iterations: plan.iterations,
        completed_proof_iterations: [...plan.iterations],
        requested_repeats: plan.rounds,
        completed_repeats: plan.iterations.length,
        workflow_run_id: expected.run_id,
        workflow_run_attempt: 1,
        platform,
        architecture: 'fixture',
        node: expected.node,
        git_commit: expected.commit,
        source_digest: expected.source_digest,
        sources,
        working_tree_dirty: false,
        bundle_digest: 'b'.repeat(64),
        success: true,
        proofs,
        operator_proofs: portfolios.operators,
        task_proofs: portfolios.tasks,
        job_proofs: portfolios.jobs,
        commands: [],
        tests: 1,
      };
      const labels = plan.baseline ? ['format', 'types', 'lint', 'pin', 'full-suite'] : [];
      for (const [group, field] of [
        ['operators', 'operator'],
        ['tasks', 'task'],
        ['jobs', 'job'],
      ]) {
        d[`${field}_requested_repeats`] = plan.portfolioRepeats;
        d[`${field}_completed_repeats`] = plan.portfolioRepeats;
        for (let i = 1; i <= plan.portfolioRepeats; i++) labels.push(`${group}-${i}`);
      }
      labels.push(...plan.iterations.map((i: number) => `proofs-${i}`));
      if (plan.baseline)
        labels.push('demo-session', 'demo-managed', 'demo-children', 'demo-acceptance');
      for (const label of labels) {
        writeFileSync(join(directory, label + '.log'), 'passed');
        d.commands.push({ label, exit_code: 0, log: label + '.log', log_digest: hash('passed') });
        if (label === 'full-suite' || /^(operators|tasks|jobs|proofs)-/.test(label)) {
          const files: string[] =
            label === 'full-suite'
              ? ['test/unit/fixture.test.ts']
              : label.startsWith('proofs-')
                ? Object.values(proofs).map((name) => `test/proofs/${name}.test.ts`)
                : portfolios[label.split('-')[0]!];
          writeFileSync(
            join(directory, label + '.json'),
            JSON.stringify({
              success: true,
              numTotalTests: files.length,
              numPassedTests: files.length,
              numFailedTests: 0,
              numPendingTests: 0,
              numTodoTests: 0,
              testResults: files.map((file) => ({
                name: '/fixture/' + file,
                status: 'passed',
                assertionResults: [{ status: 'passed' }],
              })),
            }),
          );
        }
      }
      const path = join(directory, 'manifest.json');
      writeFileSync(path, JSON.stringify(d));
      manifests.push({ path, document: d });
    }
    receipts.push({
      path: 'fixture',
      document: {
        workflow_run_id: expected.run_id,
        workflow_run_attempt: 1,
        platform,
        package: expected.package,
        version: expected.version,
        sha256: metadata.package_sha256,
        install: 'offline empty-cache',
        aliases: true,
        pinned_pi_readiness: true,
        offline_turn: true,
        daemon_restart_same_attempt: true,
        source_checkout_required: false,
      },
    });
  }
  const gates: any = Object.fromEntries(
    [
      'plan',
      'package-build',
      'package-install',
      'sites',
      'execution-boundary',
      'a2a-peer-interop',
      'service',
      'stress',
    ].map((name) => [
      name,
      { result: name === 'stress' && profile === 'quick' ? 'skipped' : 'success' },
    ]),
  );
  const options = {
    privateRuntime: {
      schema: 1,
      kind: 'salaam-private-runtime-container-proof',
      success: true,
      commit: expected.commit,
      workflow_run_id: expected.run_id,
      workflow_run_attempt: 1,
      version: expected.version,
      package_sha256: metadata.package_sha256,
      archive_sha256: 'c'.repeat(64),
      manifest_sha256: 'd'.repeat(64),
      reproducible_two_builds: true,
      rebuild_archive_sha256: 'c'.repeat(64),
      rebuild_manifest_sha256: 'd'.repeat(64),
      image: privateRuntimeImage,
      platform: 'linux',
      arch: 'x64',
      network: 'none',
      source_checkout_required: false,
      deployed_fleet: false,
      system_node_absent: true,
      installed_offline: true,
      absolute_private_node: true,
      concurrent_starts_single_owner: true,
      pinned_pi_readiness: true,
      offline_turn: true,
      reconnect_preserves_attempt: true,
    },
    manifests,
    receipts,
    packageDirectory,
    expected,
    profile,
    gates,
    packageArtifactId: '987',
  };
  return {
    ...options,
    options,
    dir,
    collect: () => collectEvidence(options),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('CI collection and promotion deny a missing or incomplete private runtime proof', () => {
  const f = fixture();
  try {
    const certificate = f.collect();
    expect(() =>
      validateCertificate({ ...certificate, private_runtime: undefined }, f.expected),
    ).toThrow('private runtime container proof');
    for (const reproducible_two_builds of [undefined, false]) {
      const privateRuntime = { ...f.options.privateRuntime, reproducible_two_builds };
      expect(() => collectEvidence({ ...f.options, privateRuntime })).toThrow(
        'private runtime container proof',
      );
      expect(() =>
        validateCertificate({ ...certificate, private_runtime: privateRuntime }, f.expected),
      ).toThrow('private runtime container proof');
    }
    f.options.privateRuntime.concurrent_starts_single_owner = false;
    expect(() => f.collect()).toThrow('private runtime container proof');
  } finally {
    f.close();
  }
});
test('quick keeps every test suite, while four proof shards cover each of the 20 rounds exactly once', () => {
  expect(acceptancePlan(['--profile', 'quick'])).toMatchObject({
    baseline: true,
    portfolioRepeats: 1,
    iterations: [1],
  });
  const rounds = [1, 2, 3, 4].flatMap(
    (i) => acceptancePlan(['--profile', 'proofs', '--shard', `${i}/4`]).iterations,
  );
  expect(rounds).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(acceptancePlan([])).toMatchObject({ profile: 'full', portfolioRepeats: 3, rounds: 20 });
  expect(acceptancePlan(['--repeats', '1']).rounds).toBe(1);
});
test.each([
  ['--profile', 'quick', '--repeats', '1'],
  ['--profile', 'quick', '--shard', '1/4'],
  ['--profile', 'proofs', '--shard', '0/4'],
  ['--profile', 'proofs', '--shard', '1/3'],
  ['--profile', 'full', '--profile', 'quick'],
  ['--repeats', '0'],
  ['--unknown', '1'],
])('invalid acceptance selection cannot silently weaken the gate: %j', (...args) => {
  expect(() => acceptancePlan(args)).toThrow();
});
test.each(['quick', 'full'])(
  'complete %s evidence is truthful about its acceptance level',
  (profile) => {
    const f = fixture(profile);
    try {
      const d = f.collect();
      expect(d.full_acceptance).toBe(profile === 'full');
      expect(d.platforms).toHaveLength(2);
      if (profile === 'full') expect(validateCertificate(d, f.expected)).toBe(d);
      else expect(() => validateCertificate(d, f.expected)).toThrow('quick');
    } finally {
      f.close();
    }
  },
);
test.each([
  'missing-shard',
  'duplicate-slot',
  'missing-platform',
  'duplicate-round',
  'missing-round',
  'failed-command',
  'changed-log',
  'failed-report',
  'wrong-count',
  'changed-bundle',
  'wrong-source',
  'dirty-checkout',
  'another-run',
  'missing-baseline',
  'missing-receipt',
  'different-package',
  'failed-gate',
  'skipped-stress',
  'tampered-package',
])('release evidence denies %s', (scenario) => {
  const f = fixture();
  try {
    const d = f.manifests[1]!.document;
    switch (scenario) {
      case 'missing-shard':
        f.manifests.splice(1, 1);
        break;
      case 'duplicate-slot':
        f.manifests[2] = structuredClone(f.manifests[1]);
        break;
      case 'missing-platform':
        f.manifests.splice(5);
        break;
      case 'duplicate-round':
        d.completed_proof_iterations[1] = d.completed_proof_iterations[0];
        break;
      case 'missing-round':
        d.completed_proof_iterations.pop();
        break;
      case 'failed-command':
        d.commands[0].exit_code = 1;
        break;
      case 'changed-log':
        writeFileSync(join(f.dir, 'linux/1/proofs-1.log'), 'changed');
        break;
      case 'failed-report':
        writeFileSync(join(f.dir, 'linux/1/proofs-1.json'), '{"success":false}');
        break;
      case 'wrong-count': {
        const path = join(f.dir, 'linux/1/proofs-1.json'),
          report = JSON.parse(readFileSync(path, 'utf8'));
        report.testResults[0].assertionResults = [];
        writeFileSync(path, JSON.stringify(report));
        break;
      }
      case 'changed-bundle':
        d.bundle_digest = 'c'.repeat(64);
        break;
      case 'wrong-source':
        d.source_digest = 'c'.repeat(64);
        break;
      case 'dirty-checkout':
        d.working_tree_dirty = true;
        break;
      case 'another-run':
        d.workflow_run_id = '456';
        break;
      case 'missing-baseline':
        f.manifests.splice(0, 1);
        break;
      case 'missing-receipt':
        f.receipts.pop();
        break;
      case 'different-package':
        f.receipts[0]!.document.sha256 = 'd'.repeat(64);
        break;
      case 'failed-gate':
        f.gates['execution-boundary'].result = 'failure';
        break;
      case 'skipped-stress':
        f.gates.stress.result = 'skipped';
        break;
      case 'tampered-package':
        writeFileSync(join(f.packageDirectory, 'salaam-cli-0.0.2.tgz'), 'changed');
        break;
    }
    expect(f.collect).toThrow();
  } finally {
    f.close();
  }
});
test('a later failed retry cannot borrow old passing evidence; successful retries may reuse unchanged earlier slots', () => {
  const f = fixture();
  try {
    f.expected.run_attempt = 2;
    const retry = structuredClone(f.manifests[1]);
    retry.document.workflow_run_attempt = 2;
    retry.document.success = false;
    f.manifests.push(retry);
    expect(f.collect).toThrow('identity or success');
    retry.document.success = true;
    expect(f.collect().full_acceptance).toBe(true);
  } finally {
    f.close();
  }
});
test('passing S6 alone cannot certify the S1–S5 recovery proofs', () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'linux/1/proofs-1.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    report.testResults = report.testResults.filter((r: any) =>
      r.name.endsWith('/required-capabilities.test.ts'),
    );
    report.numTotalTests = report.numPassedTests = 1;
    writeFileSync(path, JSON.stringify(report));
    expect(f.collect).toThrow('Required test files');
  } finally {
    f.close();
  }
});
function run(overrides = {}) {
  return {
    id: 123,
    run_attempt: 1,
    head_sha: 'f'.repeat(40),
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/ci.yml',
    repository: { full_name: 'SuperJackfruitLabs/salaam' },
    head_repository: { full_name: 'SuperJackfruitLabs/salaam' },
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}
test.each([
  { event: 'pull_request' },
  { head_branch: 'feature' },
  { head_sha: '0'.repeat(40) },
  { path: '.github/workflows/other.yml' },
  { head_repository: { full_name: 'attacker/salaam' } },
])('release promotion rejects untrusted run selection: %j', (overrides) => {
  expect(trustedMainRun(run(overrides), 'SuperJackfruitLabs/salaam', 'f'.repeat(40))).toBe(false);
});
test('resolver waits for matching main CI, falls back when unavailable, and never borrows an older success after a failed retry', async () => {
  let calls = 0,
    time = 0;
  const config = {
    repository: 'SuperJackfruitLabs/salaam',
    commit: 'f'.repeat(40),
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    waitMs: 30000,
  };
  expect(
    (
      await findMainRun({
        ...config,
        api: () => ({
          workflow_runs: [run({ status: ++calls === 1 ? 'in_progress' : 'completed' })],
        }),
      })
    ).id,
  ).toBe(123);
  expect(calls).toBe(2);
  expect(await findMainRun({ ...config, api: () => ({ workflow_runs: [] }) })).toBeNull();
  expect(
    await findMainRun({
      ...config,
      api: () => ({ workflow_runs: [run({ id: 124, conclusion: 'failure' }), run()] }),
    }),
  ).toBeNull();
});
test('promotion binds the certificate attempt, exact package artifact and both platform receipts', () => {
  const f = fixture();
  try {
    const d = f.collect(),
      r = run();
    const binding = { id: r.id, head_sha: r.head_sha };
    const artifacts = [
      {
        id: 986,
        name: 'ci-release-evidence-1',
        expired: false,
        digest: 'sha256:' + 'a'.repeat(64),
        workflow_run: binding,
      },
      {
        id: 987,
        name: 'salaam-cli-1',
        expired: false,
        digest: 'sha256:' + 'b'.repeat(64),
        workflow_run: binding,
      },
    ];
    expect(selectCertificateArtifact(artifacts, r).id).toBe(986);
    expect(validatePromotion(d, r, artifacts, f.expected).id).toBe(987);
    expect(validatePromotion(d, r, [{ ...artifacts[1], expired: true }], f.expected)).toBeNull();
    expect(validatePromotion(d, r, [], f.expected)).toBeNull();
    expect(selectCertificateArtifact(artifacts, { ...r, run_attempt: 2 })).toBeNull();
    expect(() => selectCertificateArtifact([...artifacts, artifacts[0]], r)).toThrow('Ambiguous');
    expect(() => validatePromotion({ ...d, run_attempt: 2 }, r, artifacts, f.expected)).toThrow(
      'Stale',
    );
    expect(() => validatePromotion({ ...d, profile: 'quick' }, r, artifacts, f.expected)).toThrow(
      'quick',
    );
    expect(() =>
      validatePromotion(d, run({ event: 'pull_request' }), artifacts, f.expected),
    ).toThrow('main');
    expect(() =>
      validatePromotion(
        d,
        r,
        [{ ...artifacts[1], workflow_run: { id: 456, head_sha: r.head_sha } }],
        f.expected,
      ),
    ).toThrow('missing');
  } finally {
    f.close();
  }
});
