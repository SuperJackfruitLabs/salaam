#!/usr/bin/env node
// The docs-only part of the CI plan for .github/workflows/ci.yml, and the run's verdict.
// (scripts/ci-plan.mjs is the acceptance plan; this file only decides docs-only.)
//
//   node scripts/ci-docs-only.mjs plan       in `plan`: writes docs_only=true|false (and reason)
//   node scripts/ci-docs-only.mjs aggregate  the `check` job: exits non-zero unless every job in
//                                            the run ended the way the plan selected
//
// A pull request is docs-only when every path it changes is a root README / README.*, or sits
// under docs/ or docs-site/. Then every application job and the evidence gate are skipped, and
// only `sites` (which builds both sites, since its docs checks read the landing build) and
// `docs-checks` (prettier and the docs-reference test) run. Anything else (any other path, a
// mixed change, an empty diff, a missing merge base, a failed diff, an error, any event but
// pull_request) keeps the plan the `plan` job already made. A doubt is never docs-only.
//
// Only node: imports, so both commands run without an install.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_README = /^README(\.[^/]+)?$/;
const DOCS_TREES = ['docs/', 'docs-site/'];

/** A repository-root-relative path in the docs allowlist. Case-sensitive. */
export function isDocsPath(path) {
  if (ROOT_README.test(path)) return true;
  return DOCS_TREES.some((tree) => path.startsWith(tree) && path.length > tree.length);
}

/** The plan for a complete changed-path set. An empty set is never docs-only. */
export function classify(paths) {
  if (paths.length === 0) return { docsOnly: false, reason: 'the diff is empty' };
  const other = paths.find((path) => !isDocsPath(path));
  if (other !== undefined) return { docsOnly: false, reason: `${other} is not a docs path` };
  return { docsOnly: true, reason: `all ${paths.length} changed paths are docs` };
}

/** Runs git in `cwd`. A non-zero exit, a signal or an overflowing buffer is a failure. */
export function gitIn(cwd) {
  return (args) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (run.error) return { ok: false, error: run.error.message };
    if (run.status !== 0) {
      return {
        ok: false,
        error: `git ${args[0]} exited ${run.status ?? run.signal}: ${run.stderr.trim()}`,
      };
    }
    return { ok: true, stdout: run.stdout };
  };
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Every path a pull request changes, from the merge base of base and head to head. Renames are
 * off, so a move reports both its old and its new path. An error when the set cannot be read whole.
 */
export function changedPaths(git, base, head) {
  for (const [name, sha] of [
    ['base', base],
    ['head', head],
  ]) {
    if (!SHA.test(sha) || /^0+$/.test(sha))
      return { error: `the ${name} sha is unavailable (${sha || 'empty'})` };
  }
  const mergeBase = git(['merge-base', base, head]);
  if (!mergeBase.ok) return { error: `no merge base: ${mergeBase.error}` };
  const from = mergeBase.stdout.trim();
  if (!SHA.test(from)) return { error: `no merge base: git printed ${JSON.stringify(from)}` };
  const diff = git([
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    from,
    head,
    '--',
  ]);
  if (!diff.ok) return { error: `the diff failed: ${diff.error}` };
  return { paths: diff.stdout.split('\0').filter((path) => path !== '') };
}

/** Whether a run is docs-only. Only a pull_request can be; every doubt is not. */
export function planFor({ event, base, head, git }) {
  if (event !== 'pull_request')
    return { docsOnly: false, reason: `${event || 'an unknown event'} keeps its plan` };
  try {
    const changed = changedPaths(git, base, head);
    if ('error' in changed) return { docsOnly: false, reason: changed.error };
    return classify(changed.paths);
  } catch (error) {
    return {
      docsOnly: false,
      reason: `the classifier failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The application jobs, which a docs-only or sites-only plan skips. */
export const APP_JOBS = [
  'package-build',
  'package-install',
  'execution-boundary',
  'a2a-peer-interop',
  'service',
  'tool-user',
  'stress',
  'ci-gate',
];
export const JOBS = [...APP_JOBS, 'sites', 'docs-checks'];

const want = (selected) => (selected ? 'success' : 'skipped');

/** What each judged job must report under a plan: the jobs' own `if`s, written out. */
export function expectedResults(plan) {
  const expected = Object.fromEntries(APP_JOBS.map((name) => [name, want(plan.app)]));
  expected.stress = want(plan.app && plan.profile === 'full');
  expected.sites = want(plan.sites);
  expected['docs-checks'] = want(plan.docs_only);
  return expected;
}

/**
 * Whether a run passed, from the `needs` context of the `check` job. The `plan` job must have
 * succeeded with a readable plan; then every judged job must have succeeded if the plan selected
 * it and been skipped if not. A docs-only plan must be a pull request that selects the sites and
 * docs checks and nothing else. A missing job, a failure, a cancel, an unplanned skip or run, or
 * an unreadable plan fails it.
 */
export function aggregate(needs, event) {
  if (typeof needs !== 'object' || needs === null)
    return { ok: false, reason: 'the needs context is unreadable' };
  const planJob = field(needs, 'plan');
  if (planJob === undefined) return { ok: false, reason: 'the plan job is missing' };
  const planResult = field(planJob, 'result');
  if (planResult !== 'success')
    return { ok: false, reason: `the plan job is ${String(planResult)}` };
  const outputs = field(planJob, 'outputs');
  const plan = {};
  for (const name of ['app', 'sites', 'docs_only']) {
    const value = field(outputs, name);
    if (value !== 'true' && value !== 'false')
      return { ok: false, reason: `the plan is unreadable (${name}=${String(value)})` };
    plan[name] = value === 'true';
  }
  plan.profile = field(outputs, 'profile');
  if (plan.profile !== 'quick' && plan.profile !== 'full')
    return { ok: false, reason: `the plan is unreadable (profile=${String(plan.profile)})` };
  if (plan.docs_only) {
    if (event !== 'pull_request')
      return { ok: false, reason: `a ${event || 'run with no event'} cannot be docs-only` };
    if (plan.app || !plan.sites)
      return {
        ok: false,
        reason: 'a docs-only plan must select the sites and docs checks and nothing else',
      };
  }
  for (const [name, expected] of Object.entries(expectedResults(plan))) {
    const job = field(needs, name);
    if (job === undefined) return { ok: false, reason: `the ${name} job is missing` };
    const result = field(job, 'result');
    if (result !== expected)
      return { ok: false, reason: `${name} is ${String(result)}, the plan expects ${expected}` };
  }
  return plan.docs_only
    ? {
        ok: true,
        reason:
          'docs-only: sites and docs-checks passed and every application job was skipped as planned',
      }
    : { ok: true, reason: 'every planned job passed and every other job was skipped as planned' };
}

/** An own property of an object read from JSON, or undefined. */
function field(value, key) {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
  return value[key];
}

function main(command) {
  const env = process.env;
  if (command === 'plan') {
    const plan = planFor({
      event: env.EVENT ?? '',
      base: env.BASE_SHA ?? '',
      head: env.HEAD_SHA ?? '',
      git: gitIn(process.cwd()),
    });
    const lines = `docs_only=${plan.docsOnly}\nreason=${plan.reason.replace(/[\r\n]+/g, ' ')}\n`;
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
    process.stdout.write(lines);
    return 0;
  }
  if (command === 'aggregate') {
    let needs;
    try {
      needs = JSON.parse(env.NEEDS ?? '');
    } catch {
      needs = undefined;
    }
    const verdict = aggregate(needs, env.EVENT ?? '');
    process.stdout.write(`${verdict.ok ? 'pass' : 'fail'}: ${verdict.reason}\n`);
    return verdict.ok ? 0 : 1;
  }
  process.stderr.write('usage: node scripts/ci-docs-only.mjs plan|aggregate\n');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
