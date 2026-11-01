import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDigest } from '../dist/src/config.js';
import { acceptancePlan, sourceIdentity, proofs, portfolios, hash } from './ci-plan.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const plan = acceptancePlan(process.argv.slice(2)),
  repeats = plan.rounds;
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const dir = join(root, '.state/evidence/acceptance', runId);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const operatorProofs = portfolios.operators;
const evidence = {
  schema_version: 2,
  profile: plan.profile,
  shard: plan.shard,
  proof_iterations: plan.iterations,
  completed_proof_iterations: [],
  workflow_run_id: process.env.GITHUB_RUN_ID ?? null,
  workflow_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
  run_id: runId,
  started_at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  ...sourceIdentity(root),
  bundle_digest: bundleDigest(),
  requested_repeats: repeats,
  completed_repeats: 0,
  operator_proofs: operatorProofs,
  operator_requested_repeats: plan.portfolioRepeats,
  task_proofs: portfolios.tasks,
  job_proofs: portfolios.jobs,
  job_requested_repeats: plan.portfolioRepeats,
  job_completed_repeats: 0,
  task_requested_repeats: plan.portfolioRepeats,
  task_completed_repeats: 0,
  operator_completed_repeats: 0,
  proofs,
  commands: [],
  scope: 'Host-local offline/fixture evidence. Other platforms require their own observed run.',
  success: false,
  full_acceptance: false,
};
const manifest = join(dir, 'manifest.json');
const save = () =>
  writeFileSync(manifest, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const execute = async (label, command, args) => {
  const path = join(dir, label + '.log');
  const fd = openSync(path, 'w', 0o600);
  const started = Date.now();
  console.log(label);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', fd, fd] });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => closeSync(fd));
  evidence.commands.push({
    label,
    command: [command, ...args],
    exit_code: code,
    duration_ms: Date.now() - started,
    log: relative(dir, path),
    log_digest: hash(readFileSync(path)),
  });
  save();
  if (code !== 0) throw new Error(label + ' failed; inspect ' + path);
};
try {
  save();
  if (plan.baseline) {
    await execute('format', 'npm', ['run', 'format:check']);
    await execute('types', 'npm', ['run', 'check']);
    await execute('lint', 'npm', ['run', 'lint']);
    await execute('pin', 'npm', ['run', 'verify:pi']);
    const full = join(dir, 'full-suite.json');
    await execute('full-suite', 'npm', ['test', '--', '--reporter=json', '--outputFile=' + full]);
    evidence.tests = JSON.parse(readFileSync(full, 'utf8')).numTotalTests;
    for (let iteration = 1; iteration <= plan.portfolioRepeats; iteration++) {
      const report = join(dir, 'operators-' + iteration + '.json');
      await execute('operators-' + iteration, process.execPath, [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...operatorProofs,
        '--reporter=json',
        '--outputFile=' + report,
      ]);
      const result = JSON.parse(readFileSync(report, 'utf8'));
      if (!result.success || result.numFailedTests || !result.numTotalTests)
        throw new Error('Incomplete operator proof report');
      evidence.operator_completed_repeats = iteration;
      save();
    }
    for (let iteration = 1; iteration <= plan.portfolioRepeats; iteration++) {
      const report = join(dir, 'tasks-' + iteration + '.json');
      await execute('tasks-' + iteration, process.execPath, [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...evidence.task_proofs,
        '--reporter=json',
        '--outputFile=' + report,
      ]);
      const result = JSON.parse(readFileSync(report, 'utf8'));
      if (!result.success || result.numFailedTests || !result.numTotalTests)
        throw new Error('Incomplete task recovery proof report');
      evidence.task_completed_repeats = iteration;
      save();
    }
    for (let iteration = 1; iteration <= plan.portfolioRepeats; iteration++) {
      const report = join(dir, 'jobs-' + iteration + '.json');
      await execute('jobs-' + iteration, process.execPath, [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...evidence.job_proofs,
        '--reporter=json',
        '--outputFile=' + report,
      ]);
      const result = JSON.parse(readFileSync(report, 'utf8'));
      if (!result.success || result.numFailedTests || !result.numTotalTests)
        throw new Error('Incomplete job recovery proof report');
      evidence.job_completed_repeats = iteration;
      save();
    }
  }
  const files = Object.values(proofs).map((name) => 'test/proofs/' + name + '.test.ts');
  for (const iteration of plan.iterations) {
    const report = join(dir, 'proofs-' + iteration + '.json');
    await execute('proofs-' + iteration, process.execPath, [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      ...files,
      '--reporter=json',
      '--outputFile=' + report,
    ]);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    if (!result.success || result.numFailedTests || !result.numTotalTests)
      throw new Error('Incomplete proof report');
    evidence.completed_repeats++;
    evidence.completed_proof_iterations.push(iteration);
    save();
  }
  if (plan.baseline)
    for (const name of ['session', 'managed', 'children', 'acceptance'])
      await execute('demo-' + name, 'npm', ['run', 'demo:' + name]);
  evidence.success = true;
  evidence.full_acceptance =
    plan.profile === 'full' &&
    repeats >= 20 &&
    evidence.operator_completed_repeats === 3 &&
    evidence.task_completed_repeats === 3 &&
    evidence.job_completed_repeats === 3;
  evidence.finished_at = new Date().toISOString();
  save();
  writeFileSync(
    join(root, '.state/evidence/latest-acceptance.json'),
    JSON.stringify({
      manifest,
      run_id: runId,
      success: true,
      full_acceptance: evidence.full_acceptance,
    }) + '\n',
  );
  console.log(
    JSON.stringify({
      manifest,
      tests: evidence.tests,
      proof_repeats: evidence.completed_repeats,
      full_acceptance: evidence.full_acceptance,
    }),
  );
} catch (error) {
  evidence.error = error.message;
  evidence.finished_at = new Date().toISOString();
  save();
  throw error;
}
