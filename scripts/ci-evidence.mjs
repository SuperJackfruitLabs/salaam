import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePrivateRuntimeReceipt } from './runtime/receipt.mjs';
import {
  hash,
  sourceIdentity,
  proofs,
  portfolios,
  PROOF_ROUNDS,
  PROOF_SHARDS,
  acceptancePlan,
} from './ci-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireThat = (value, message) => {
  if (!value) throw Error(message);
};
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (path) => hash(readFileSync(path));
export function filesBelow(directory, name) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? filesBelow(path, name)
      : entry.isFile() && entry.name === name
        ? [path]
        : [];
  });
}
function latestSlots(records, key, expected) {
  const slots = new Map();
  for (const record of records) {
    const d = record.document;
    requireThat(
      String(d.workflow_run_id) === String(expected.run_id) &&
        Number.isSafeInteger(d.workflow_run_attempt) &&
        d.workflow_run_attempt > 0 &&
        d.workflow_run_attempt <= expected.run_attempt,
      'Evidence belongs to another run or attempt',
    );
    const slot = key(d),
      previous = slots.get(slot);
    requireThat(
      !previous || previous.document.workflow_run_attempt !== d.workflow_run_attempt,
      'Duplicate evidence slot',
    );
    if (!previous || previous.document.workflow_run_attempt < d.workflow_run_attempt)
      slots.set(slot, record);
  }
  return slots;
}
function report(path, requiredFiles) {
  const d = json(path);
  requireThat(
    d.success === true &&
      d.numTotalTests > 0 &&
      d.numFailedTests === 0 &&
      d.numPassedTests === d.numTotalTests &&
      !d.numPendingTests &&
      !d.numTodoTests,
    'Incomplete or failed test report',
  );
  requireThat(
    Array.isArray(d.testResults) &&
      d.testResults.length > 0 &&
      d.testResults.every(
        (r) => r.status === 'passed' && r.assertionResults.every((a) => a.status === 'passed'),
      ),
    'Test assertions did not all pass',
  );
  requireThat(
    d.testResults.reduce((count, r) => count + r.assertionResults.length, 0) === d.numTotalTests,
    'Test assertion count mismatch',
  );
  const observed = d.testResults.map((r) =>
    requiredFiles.find((file) => r.name?.replaceAll('\\', '/').endsWith('/' + file)),
  );
  requireThat(
    requiredFiles.length > 0 &&
      observed.length === requiredFiles.length &&
      observed.every(Boolean) &&
      new Set(observed).size === requiredFiles.length,
    'Required test files did not all run',
  );
  return d.numTotalTests;
}
function validateManifest(record, expected, profile, shard) {
  const d = record.document,
    directory = dirname(record.path);
  requireThat(
    d.schema_version === 2 &&
      d.success === true &&
      d.working_tree_dirty === false &&
      d.git_commit === expected.commit &&
      d.source_digest === expected.source_digest &&
      d.node === expected.node,
    'Acceptance identity or success mismatch',
  );
  requireThat(JSON.stringify(d.proofs) === JSON.stringify(proofs), 'Proof portfolio changed');
  requireThat(
    hash(JSON.stringify(d.sources)) === d.source_digest,
    'Source manifest digest mismatch',
  );
  requireThat(
    d.profile === profile && JSON.stringify(d.shard) === JSON.stringify(shard),
    'Wrong acceptance profile or shard',
  );
  const plan = acceptancePlan([
    '--profile',
    profile,
    ...(shard ? ['--shard', `${shard.index}/${shard.count}`] : []),
  ]);
  for (const [group, field] of [
    ['operators', 'operator'],
    ['tasks', 'task'],
    ['jobs', 'job'],
  ])
    requireThat(
      JSON.stringify(d[`${field}_proofs`]) === JSON.stringify(portfolios[group]),
      'Recovery test portfolio changed',
    );
  requireThat(
    JSON.stringify(d.proof_iterations) === JSON.stringify(plan.iterations) &&
      JSON.stringify(d.completed_proof_iterations) === JSON.stringify(plan.iterations) &&
      d.completed_repeats === plan.iterations.length &&
      d.requested_repeats === plan.rounds,
    'Missing, duplicate or misplaced proof rounds',
  );
  const labels = plan.baseline ? ['format', 'types', 'pin', 'full-suite'] : [];
  for (const group of ['operators', 'tasks', 'jobs']) {
    const field = group === 'operators' ? 'operator' : group === 'tasks' ? 'task' : 'job';
    requireThat(
      d[`${field}_requested_repeats`] === plan.portfolioRepeats &&
        d[`${field}_completed_repeats`] === plan.portfolioRepeats,
      'Incomplete recovery portfolio',
    );
    for (let i = 1; i <= plan.portfolioRepeats; i++) labels.push(`${group}-${i}`);
  }
  labels.push(...plan.iterations.map((i) => `proofs-${i}`));
  if (plan.baseline)
    labels.push(...['session', 'managed', 'children', 'acceptance'].map((name) => `demo-${name}`));
  requireThat(
    Array.isArray(d.commands) &&
      d.commands.length === labels.length &&
      new Set(d.commands.map((c) => c.label)).size === labels.length,
    'Missing or duplicate acceptance commands',
  );
  for (const label of labels) {
    const c = d.commands.find((entry) => entry.label === label);
    requireThat(
      c &&
        c.exit_code === 0 &&
        c.log === `${label}.log` &&
        digest(join(directory, c.log)) === c.log_digest,
      'Acceptance log missing or changed',
    );
    if (label === 'full-suite' || /^(operators|tasks|jobs|proofs)-/.test(label)) {
      const files =
        label === 'full-suite'
          ? d.sources
              .map((s) => s.path)
              .filter(
                (path) => /^test\/.*\.test\.ts$/.test(path) && !path.startsWith('test/acceptance/'),
              )
          : label.startsWith('proofs-')
            ? Object.values(proofs).map((name) => `test/proofs/${name}.test.ts`)
            : portfolios[label.split('-')[0]];
      const tests = report(join(directory, `${label}.json`), files);
      if (label === 'full-suite') requireThat(tests === d.tests, 'Full-suite count mismatch');
    }
  }
  requireThat(/^[a-f0-9]{64}$/.test(d.bundle_digest), 'Missing Pi bundle identity');
  return d;
}
export function validatePackage(directory, expected) {
  const metadata = json(join(directory, 'release.json'));
  requireThat(
    metadata.commit === expected.commit &&
      metadata.dirty === false &&
      metadata.version === expected.version &&
      metadata.tag === `v${expected.version}` &&
      metadata.node === expected.node.slice(1) &&
      metadata.npm === expected.npm &&
      metadata.package === expected.package,
    'Package metadata does not match the release',
  );
  const tarball = `salaam-cli-${expected.version}.tgz`;
  requireThat(
    digest(join(directory, tarball)) === metadata.package_sha256,
    'Package checksum mismatch',
  );
  const sums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  requireThat(sums.length === 3, 'Unexpected checksum manifest');
  const seen = new Set();
  for (const line of sums) {
    const m = /^([a-f0-9]{64})  (.+)$/.exec(line);
    requireThat(
      m && [tarball, 'install.sh', 'release.json'].includes(m[2]) && !seen.has(m[2]),
      'Invalid checksum entry',
    );
    seen.add(m[2]);
    requireThat(digest(join(directory, m[2])) === m[1], 'Release asset checksum mismatch');
  }
  requireThat(hash(JSON.stringify(metadata.pin)) === expected.pin_digest, 'Pi pin mismatch');
  return {
    sha256: metadata.package_sha256,
    metadata_sha256: digest(join(directory, 'release.json')),
    installer_sha256: digest(join(directory, 'install.sh')),
  };
}
export function validateCertificate(certificate, expected) {
  requireThat(
    certificate.schema_version === 1 &&
      certificate.kind === 'salaam-ci-evidence' &&
      certificate.profile === 'full' &&
      certificate.full_acceptance === true,
    'A quick or incomplete run cannot authorize a release',
  );
  for (const key of [
    'repository',
    'commit',
    'source_digest',
    'node',
    'npm',
    'pin_digest',
    'version',
  ])
    requireThat(certificate[key] === expected[key], `Certificate ${key} mismatch`);
  requireThat(certificate.package?.name === expected.package, 'Certificate package mismatch');
  requireThat(
    String(certificate.run_id) === String(expected.run_id) &&
      certificate.run_attempt === expected.run_attempt,
    'Stale certificate attempt',
  );
  requireThat(
    certificate.platforms?.length === 2 &&
      new Set(certificate.platforms.map((p) => p.platform)).size === 2,
    'Missing platform evidence',
  );
  for (const platform of ['linux', 'darwin']) {
    const p = certificate.platforms.find((entry) => entry.platform === platform);
    requireThat(
      p?.full_suite_tests > 0 &&
        p.proof_rounds === PROOF_ROUNDS &&
        p.portfolio_repeats === 3 &&
        p.package_verified === true,
      'Incomplete platform certificate',
    );
  }
  requireThat(
    /^[a-f0-9]{64}$/.test(certificate.package?.sha256) &&
      /^\d+$/.test(String(certificate.package.artifact_id)),
    'Missing package identity',
  );
  validatePrivateRuntimeReceipt(certificate.private_runtime, expected, certificate.package.sha256);
  return certificate;
}
export function validateGates(gates, profile) {
  requireThat(['quick', 'full'].includes(profile), 'Unknown CI evidence profile');
  requireThat(gates.plan?.result === 'success', 'CI plan did not succeed');
  for (const name of [
    'package-build',
    'package-install',
    'sites',
    'execution-boundary',
    'a2a-peer-interop',
    'service',
  ])
    requireThat(gates[name]?.result === 'success', `Required gate failed: ${name}`);
  requireThat(
    gates.stress?.result === (profile === 'full' ? 'success' : 'skipped'),
    'Stress gate did not match its profile',
  );
}
export function collectEvidence({
  manifests,
  receipts,
  privateRuntime,
  packageDirectory,
  expected,
  profile,
  gates,
  packageArtifactId,
}) {
  validateGates(gates, profile);
  const slots = latestSlots(
    manifests,
    (d) => `${d.platform}/${d.profile}/${d.shard?.index ?? 0}`,
    expected,
  );
  requireThat(
    slots.size === (profile === 'full' ? 10 : 2),
    'Missing or unexpected acceptance slots',
  );
  const packages = latestSlots(receipts, (d) => d.platform, expected);
  requireThat(packages.size === 2, 'Missing package installation evidence');
  const pkg = validatePackage(packageDirectory, expected),
    platforms = [],
    bundles = new Set();
  for (const platform of ['linux', 'darwin']) {
    const baseProfile = profile === 'full' ? 'baseline' : 'quick';
    const record = slots.get(`${platform}/${baseProfile}/0`);
    requireThat(record, 'Missing full test suite');
    const base = validateManifest(record, expected, baseProfile, null);
    bundles.add(base.bundle_digest);
    if (profile === 'full')
      for (let index = 1; index <= PROOF_SHARDS; index++) {
        const part = slots.get(`${platform}/proofs/${index}`);
        requireThat(part, 'Missing proof shard');
        bundles.add(
          validateManifest(part, expected, 'proofs', { index, count: PROOF_SHARDS }).bundle_digest,
        );
      }
    const receipt = packages.get(platform)?.document;
    requireThat(
      receipt &&
        receipt.sha256 === pkg.sha256 &&
        receipt.version === expected.version &&
        receipt.package === expected.package &&
        receipt.install === 'offline empty-cache' &&
        ['aliases', 'pinned_pi_readiness', 'offline_turn', 'daemon_restart_same_attempt'].every(
          (key) => receipt[key] === true,
        ) &&
        receipt.source_checkout_required === false,
      'Package was not verified on both platforms',
    );
    platforms.push({
      platform,
      architecture: base.architecture,
      full_suite_tests: base.tests,
      proof_rounds: profile === 'full' ? PROOF_ROUNDS : 1,
      portfolio_repeats: profile === 'full' ? 3 : 1,
      package_verified: true,
    });
  }
  requireThat(bundles.size === 1, 'Pi/control bundle changed between proof shards');
  return {
    schema_version: 1,
    kind: 'salaam-ci-evidence',
    profile,
    full_acceptance: profile === 'full',
    ...expected,
    package: { name: expected.package, ...pkg, artifact_id: String(packageArtifactId) },
    platforms,
    bundle_digest: [...bundles][0],
    private_runtime: validatePrivateRuntimeReceipt(privateRuntime, expected, pkg.sha256),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateGates(JSON.parse(process.env.CI_NEEDS), process.env.CI_PROFILE);
  if (process.argv[2] === '--gates-only') process.exit(0);
  const pkg = json(join(root, 'package.json')),
    identity = sourceIdentity(root);
  requireThat(!identity.working_tree_dirty, 'CI checkout is dirty');
  const expected = {
    repository: process.env.GITHUB_REPOSITORY,
    commit: identity.git_commit,
    source_digest: identity.source_digest,
    node: process.version,
    npm: pkg.packageManager,
    pin_digest: hash(JSON.stringify(json(join(root, 'pi-pin.json')))),
    version: pkg.version,
    package: pkg.name,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  const directory = join(root, '.state/ci-input');
  const privateRuntimeRecords = filesBelow(directory, 'private-runtime.json');
  requireThat(privateRuntimeRecords.length === 1, 'Missing or duplicate private runtime proof');
  const certificate = collectEvidence({
    privateRuntime: json(privateRuntimeRecords[0]),
    manifests: filesBelow(directory, 'manifest.json').map((path) => ({
      path,
      document: json(path),
    })),
    receipts: filesBelow(directory, 'package-install.json').map((path) => ({
      path,
      document: json(path),
    })),
    packageDirectory: join(root, '.state/release'),
    expected,
    profile: process.env.CI_PROFILE,
    gates: JSON.parse(process.env.CI_NEEDS),
    packageArtifactId: process.env.CI_PACKAGE_ARTIFACT_ID,
  });
  mkdirSync(join(root, '.state/ci-evidence'), { recursive: true });
  writeFileSync(
    join(root, '.state/ci-evidence/ci-release-evidence.json'),
    JSON.stringify(certificate, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      profile: certificate.profile,
      full_acceptance: certificate.full_acceptance,
      platforms: certificate.platforms,
    }),
  );
}
