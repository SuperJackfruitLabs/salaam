import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, hash } from './ci-plan.mjs';
import { validateCertificate, validatePackage } from './ci-evidence.mjs';

export function trustedMainRun(run, repository, commit) {
  return (
    run.head_sha === commit &&
    run.head_branch === 'main' &&
    run.event === 'push' &&
    run.path === '.github/workflows/ci.yml' &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository
  );
}
export function selectCertificateArtifact(artifacts, run) {
  const matches = artifacts.filter(
    (a) => a.name === `ci-release-evidence-${run.run_attempt}` && !a.expired,
  );
  if (!matches.length) return null;
  if (
    matches.length !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? '') ||
    matches[0].workflow_run?.id !== run.id ||
    matches[0].workflow_run?.head_sha !== run.head_sha
  )
    throw Error('Ambiguous or unbound CI certificate artifact');
  return matches[0];
}
export async function findMainRun({
  api,
  repository,
  commit,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  waitMs = 45 * 60 * 1000,
}) {
  const deadline = now() + waitMs;
  for (;;) {
    const data = api(
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&branch=main&event=push&per_page=100`,
    );
    const runs = data.workflow_runs
      .filter((run) => trustedMainRun(run, repository, commit))
      .sort((a, b) => b.id - a.id);
    const run = runs[0];
    if (!run) return null;
    if (run.status === 'completed') return run.conclusion === 'success' ? run : null;
    if (now() >= deadline) return null;
    await sleep(20000);
  }
}
export function validatePromotion(certificate, run, artifacts, expected) {
  if (
    !trustedMainRun(run, expected.repository, expected.commit) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw Error('Only successful main CI may authorize promotion');
  validateCertificate(certificate, {
    ...expected,
    run_id: String(run.id),
    run_attempt: run.run_attempt,
  });
  const pkg = artifacts.find((a) => String(a.id) === certificate.package.artifact_id);
  if (!pkg || pkg.expired) return null;
  if (
    !pkg ||
    pkg.expired ||
    !/^salaam-cli-\d+$/.test(pkg.name) ||
    !/^sha256:[a-f0-9]{64}$/.test(pkg.digest ?? '') ||
    pkg.workflow_run?.id !== run.id ||
    pkg.workflow_run?.head_sha !== run.head_sha
  )
    throw Error('Certified package artifact is missing or expired');
  return pkg;
}
const root = fileURLToPath(new URL('..', import.meta.url));
// The release gate's own check (`check` in .github/release-config.json), run by the suite's
// shared release workflow at the tag after it found main CI's successful run for the tag's
// commit (CI_RUN_ID, attempt CI_RUN_ATTEMPT). It fails closed: the release ships that run's
// `salaam-cli-<attempt>` artifact only when this proves it is the certified, attested package.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw Error('Missing repository identity');
  const identity = sourceIdentity(root);
  if (identity.working_tree_dirty) throw Error('Release checkout is dirty');
  if (process.env.RELEASE_SHA && identity.git_commit !== process.env.RELEASE_SHA)
    throw Error('The checkout is not the tagged commit');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  const expected = {
    repository,
    commit: identity.git_commit,
    source_digest: identity.source_digest,
    node: process.version,
    npm: pkg.packageManager,
    pin_digest: hash(JSON.stringify(JSON.parse(readFileSync(join(root, 'pi-pin.json'))))),
    version: pkg.version,
    package: pkg.name,
  };
  const gh = (...args) =>
    execFileSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const api = (path) => JSON.parse(gh('api', path));
  const rerun = `Re-run all jobs of main CI for ${expected.commit}, then the release (gh workflow run release.yml -f tag=v${expected.version}).`;
  const run = process.env.CI_RUN_ID
    ? api(`repos/${repository}/actions/runs/${process.env.CI_RUN_ID}`)
    : await findMainRun({ api, repository, commit: expected.commit });
  if (!run) throw Error(`No successful full main CI run for this commit. ${rerun}`);
  if (process.env.CI_RUN_ATTEMPT && String(run.run_attempt) !== process.env.CI_RUN_ATTEMPT)
    throw Error('Main CI was re-run while the release checked it. Run the release again.');
  const pages = JSON.parse(
    gh(
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    ),
  );
  const artifacts = pages.flatMap((p) => p.artifacts);
  const artifact = selectCertificateArtifact(artifacts, run);
  if (!artifact) throw Error(`Main CI's release certificate is missing or expired. ${rerun}`);
  const temp = mkdtempSync(join(tmpdir(), 'sal-promote-'));
  try {
    gh(
      'run',
      'download',
      String(run.id),
      '--repo',
      repository,
      '--name',
      artifact.name,
      '--dir',
      join(temp, 'certificate'),
    );
    const certificate = JSON.parse(
      readFileSync(join(temp, 'certificate/ci-release-evidence.json')),
    );
    const packageArtifact = validatePromotion(certificate, run, artifacts, expected);
    if (!packageArtifact) throw Error(`The certified package is missing or expired. ${rerun}`);
    // The workflow ships `salaam-cli-<attempt>` of this run: it must be the certified one.
    if (packageArtifact.name !== `salaam-cli-${run.run_attempt}`)
      throw Error(
        `The certified package is ${packageArtifact.name}, from an earlier attempt. ${rerun}`,
      );
    gh(
      'run',
      'download',
      String(run.id),
      '--repo',
      repository,
      '--name',
      packageArtifact.name,
      '--dir',
      join(temp, 'package'),
    );
    const actual = validatePackage(join(temp, 'package'), expected);
    for (const key of ['sha256', 'metadata_sha256', 'installer_sha256'])
      if (actual[key] !== certificate.package[key]) throw Error('Certified release bytes changed');
    gh(
      'attestation',
      'verify',
      join(temp, 'package', `salaam-cli-${expected.version}.tgz`),
      '--repo',
      repository,
      '--signer-workflow',
      `${repository}/.github/workflows/ci.yml`,
      '--source-digest',
      expected.commit,
      '--source-ref',
      'refs/heads/main',
      '--deny-self-hosted-runners',
    );
    console.log(
      JSON.stringify({
        verified: true,
        commit: expected.commit,
        source_run_id: run.id,
        source_run_attempt: run.run_attempt,
        certificate_artifact_id: artifact.id,
        package_artifact: packageArtifact.name,
        package_sha256: actual.sha256,
      }),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
