// The docs-only CI plan (scripts/ci-docs-only.mjs, .github/workflows/ci.yml): the classifier
// fails closed, the `plan` job keeps its old outputs unless the change is docs-only, and the
// `check` aggregate passes only for the graph its plan selected.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../src/core/config.js';

type GitResult = { ok: true; stdout: string } | { ok: false; error: string };
type Git = (args: string[]) => GitResult;
interface Plan {
  docsOnly: boolean;
  reason: string;
}
interface Verdict {
  ok: boolean;
  reason: string;
}
interface Module {
  APP_JOBS: string[];
  JOBS: string[];
  aggregate: (needs: unknown, event: string) => Verdict;
  classify: (paths: string[]) => Plan;
  gitIn: (cwd: string) => Git;
  isDocsPath: (path: string) => boolean;
  planFor: (input: { event: string; base: string; head: string; git: Git }) => Plan;
}

const SCRIPT = join(ROOT, 'scripts/ci-docs-only.mjs');
const loaded: Module = await import(pathToFileURL(SCRIPT).href);
const { APP_JOBS, JOBS, aggregate, classify, gitIn, isDocsPath, planFor } = loaded;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const fakeGit =
  (paths: string[]): Git =>
  (args) =>
    args[0] === 'merge-base'
      ? { ok: true, stdout: `${SHA_A}\n` }
      : { ok: true, stdout: paths.map((p) => `${p}\0`).join('') };
const noMergeBase: Git = (args) =>
  args[0] === 'merge-base' ? { ok: false, error: 'exit 1' } : { ok: true, stdout: 'README.md\0' };
const blankMergeBase: Git = (args) =>
  args[0] === 'merge-base' ? { ok: true, stdout: '\n' } : { ok: true, stdout: 'README.md\0' };
const failedDiff: Git = (args) =>
  args[0] === 'merge-base'
    ? { ok: true, stdout: SHA_A }
    : { ok: false, error: 'spawnSync git ENOBUFS' };
const throwingGit: Git = () => {
  throw new Error('boom');
};
const pr = (git: Git, base = SHA_A, head = SHA_B) =>
  planFor({ event: 'pull_request', base, head, git });
const cli = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });

describe('classifier', () => {
  test.each([
    ['README.md only', ['README.md']],
    ['bare README', ['README']],
    [
      'README + docs/** + docs-site/**',
      ['README', 'docs/tui.md', 'docs/evidence/m9-coding-linux-x64.json', 'docs-site/pages.json'],
    ],
  ])('docs-only: %s', (_name, paths) => {
    expect(pr(fakeGit(paths)).docsOnly).toBe(true);
  });

  test.each([
    ['docs + application source', ['docs/cli.md', 'src/cli/help.ts']],
    ['workflow', ['.github/workflows/ci.yml']],
    ['release config', ['.github/release-config.json']],
    ['the planner itself', ['scripts/ci-docs-only.mjs']],
    ['root package', ['package.json']],
    ['root lock', ['package-lock.json']],
    ['shrinkwrap', ['npm-shrinkwrap.json']],
    ['pinned runtime', ['pi-pin.json']],
    ['generated product artifact (fixture)', ['test/fixtures/agentpod-board-read-v1.json']],
    ['landing', ['landing/src/pages/index.astro']],
    ['site config read by both sites', ['site.config.mjs']],
    ['the hosted installer', ['install.sh']],
    ['unknown path', ['CHANGELOG.md']],
    ['agent notes', ['AGENTS.md']],
    ['README below another directory', ['harness-runtime/README.md']],
    ['README lookalike', ['READMEx.md']],
    ['case differs', ['readme.md']],
    ['Docs/ is not docs/', ['Docs/cli.md']],
    ['a file named docs', ['docs']],
    ['the docs/ prefix alone', ['docs/']],
    ['docs-siteX/ is not docs-site/', ['docs-siteX/a.md']],
    ['a README.* that is a directory', ['README.d/x.md']],
  ])('not docs-only: %s', (_name, paths) => {
    expect(pr(fakeGit(paths)).docsOnly).toBe(false);
  });

  test('an empty diff is not docs-only', () => {
    expect(pr(fakeGit([]))).toEqual({ docsOnly: false, reason: 'the diff is empty' });
    expect(classify([]).docsOnly).toBe(false);
  });

  test.each([
    ['empty base', '', SHA_B],
    ['zero base', '0'.repeat(40), SHA_B],
    ['empty head', SHA_A, ''],
    ['short sha', 'abc123', SHA_B],
  ])('an unavailable sha is not docs-only: %s', (_name, base, head) => {
    const plan = pr(fakeGit(['README.md']), base, head);
    expect(plan.docsOnly).toBe(false);
    expect(plan.reason).toContain('unavailable');
  });

  test('a missing merge base, a failed diff and a classifier error are not docs-only', () => {
    expect(pr(noMergeBase)).toEqual({ docsOnly: false, reason: 'no merge base: exit 1' });
    expect(pr(blankMergeBase).docsOnly).toBe(false);
    expect(pr(failedDiff)).toEqual({
      docsOnly: false,
      reason: 'the diff failed: spawnSync git ENOBUFS',
    });
    expect(pr(throwingGit)).toEqual({ docsOnly: false, reason: 'the classifier failed: boom' });
  });

  test.each([
    'push',
    'schedule',
    'workflow_dispatch',
    'workflow_call',
    'pull_request_target',
    'merge_group',
    '',
  ])('the "%s" event is never docs-only, even for a docs-only diff', (event) => {
    expect(planFor({ event, base: SHA_A, head: SHA_B, git: fakeGit(['README.md']) }).docsOnly).toBe(
      false,
    );
  });

  test('isDocsPath matches only the three families', () => {
    expect(
      ['README', 'README.md', 'README.de.md', 'docs/a', 'docs-site/a/b'].every(isDocsPath),
    ).toBe(true);
    expect(
      ['README/', 'src/README.md', 'docs', 'docs-site', 'xdocs/a', '.docs/a'].some(isDocsPath),
    ).toBe(false);
  });
});

describe('classifier against a real repository', () => {
  let dir = '';
  let base = '';
  const sh = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    sh('add', '-A');
    sh('commit', '-q', '-m', message);
    return sh('rev-parse', 'HEAD');
  };
  const branch = (name: string, change: () => void) => {
    sh('checkout', '-q', '-B', name, base);
    change();
    return commit(name);
  };
  const plan = (head: string, from = base) =>
    planFor({ event: 'pull_request', base: from, head, git: gitIn(dir) });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-'));
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 'ci@example.invalid');
    sh('config', 'user.name', 'ci');
    sh('config', 'commit.gpgsign', 'false');
    write('README.md', 'readme\n');
    write('docs/guide.md', 'guide\n');
    write('src/app.ts', 'export {};\n');
    base = commit('base');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a docs-only branch is docs-only', () => {
    const head = branch('docs', () => {
      write('README.md', 'readme, edited\n');
      write('docs/new page.md', 'a path with a space\n');
      write('docs-site/index.md', 'site\n');
    });
    expect(plan(head)).toEqual({ docsOnly: true, reason: 'all 3 changed paths are docs' });
  });

  test('renames across the boundary are not docs-only; within docs/ they are', () => {
    const out = branch('rename', () =>
      renameSync(join(dir, 'docs/guide.md'), join(dir, 'src/guide.ts')),
    );
    expect(plan(out).docsOnly).toBe(false);
    const into = branch('rename-in', () =>
      renameSync(join(dir, 'src/app.ts'), join(dir, 'docs/app.ts')),
    );
    expect(plan(into)).toEqual({ docsOnly: false, reason: 'src/app.ts is not a docs path' });
    const within = branch('rename-docs', () =>
      renameSync(join(dir, 'docs/guide.md'), join(dir, 'docs/moved.md')),
    );
    expect(plan(within).docsOnly).toBe(true);
  });

  test('a large docs-only diff is read whole', { timeout: 60_000 }, () => {
    const head = branch('large', () => {
      for (let i = 0; i < 4000; i++) write(`docs/bulk/page-${i}.md`, `${i}\n`);
    });
    expect(plan(head)).toEqual({ docsOnly: true, reason: 'all 4000 changed paths are docs' });
    const mixed = branch('large-mixed', () => {
      for (let i = 0; i < 4000; i++) write(`docs/bulk/page-${i}.md`, `${i}\n`);
      write('zz-last.ts', 'export {};\n');
    });
    expect(plan(mixed).docsOnly).toBe(false);
  });

  test('an empty commit, a base not in the clone and unrelated histories are not docs-only', () => {
    sh('checkout', '-q', '-B', 'empty', base);
    sh('commit', '-q', '--allow-empty', '-m', 'empty');
    expect(plan(sh('rev-parse', 'HEAD'))).toEqual({ docsOnly: false, reason: 'the diff is empty' });
    const head = branch('docs-2', () => write('README.md', 'again\n'));
    expect(plan(head, 'c'.repeat(40)).reason).toMatch(/^no merge base/);
    sh('checkout', '-q', '--orphan', 'orphan');
    sh('rm', '-rqf', '.');
    write('README.md', 'orphan\n');
    expect(plan(commit('orphan')).reason).toMatch(/^no merge base/);
  });
});

const RESULTS = ['success', 'failure', 'skipped', 'cancelled', 'missing'] as const;
type Outputs = Record<string, string | undefined>;

/** A needs context: `outputs` is the plan job's outputs, `results` each judged job's result. */
function needsFor(planResult: string, outputs: Outputs, results: Record<string, string>) {
  const needs: Record<string, unknown> = {};
  if (planResult !== 'missing') needs.plan = { result: planResult, outputs };
  for (const [name, result] of Object.entries(results))
    if (result !== 'missing') needs[name] = { result, outputs: {} };
  return needs;
}

const PLANS = {
  docsOnly: { profile: 'quick', app: 'false', sites: 'true', docs_only: 'true' },
  quick: { profile: 'quick', app: 'true', sites: 'true', docs_only: 'false' },
  full: { profile: 'full', app: 'true', sites: 'true', docs_only: 'false' },
  sitesOnly: { profile: 'quick', app: 'false', sites: 'true', docs_only: 'false' },
  nothing: { profile: 'quick', app: 'false', sites: 'false', docs_only: 'false' },
} satisfies Record<string, Outputs>;

const want = (on: boolean) => (on ? 'success' : 'skipped');

/** The jobs' own `if`s, written out independently of the script. */
function expected(outputs: Outputs): Record<string, string> {
  const app = outputs.app === 'true';
  return {
    'package-build': want(app),
    'package-install': want(app),
    'execution-boundary': want(app),
    'a2a-peer-interop': want(app),
    service: want(app),
    'tool-user': want(app),
    stress: want(app && outputs.profile === 'full'),
    'ci-gate': want(app),
    sites: want(outputs.sites === 'true'),
    'docs-checks': want(outputs.docs_only === 'true'),
  };
}

describe('aggregate truth table', () => {
  test('it judges every job in the graph', () => {
    expect(new Set(JOBS)).toEqual(new Set(Object.keys(expected(PLANS.full))));
    expect(APP_JOBS).not.toContain('sites');
  });

  for (const event of ['pull_request', 'push']) {
    for (const [name, outputs] of Object.entries(PLANS)) {
      const valid = !(name === 'docsOnly' && event !== 'pull_request');
      test(`${event} ${name}: the planned graph ${valid ? 'passes' : 'fails'}`, () => {
        expect(aggregate(needsFor('success', outputs, expected(outputs)), event).ok).toBe(valid);
      });
      test(`${event} ${name}: a plan job that did not succeed fails`, () => {
        for (const result of RESULTS.filter((r) => r !== 'success'))
          expect(aggregate(needsFor(result, outputs, expected(outputs)), event).ok).toBe(false);
      });
      test(`${event} ${name}: every other result for every job fails`, () => {
        const wanted = expected(outputs);
        for (const job of JOBS)
          for (const result of RESULTS.filter((r) => r !== wanted[job])) {
            const { ok } = aggregate(
              needsFor('success', outputs, { ...wanted, [job]: result }),
              event,
            );
            expect({ job, result, ok }).toEqual({ job, result, ok: false });
          }
      });
    }
  }

  test('a known failing docs fixture fails the docs-only run', () => {
    for (const job of ['sites', 'docs-checks'])
      expect(
        aggregate(
          needsFor('success', PLANS.docsOnly, { ...expected(PLANS.docsOnly), [job]: 'failure' }),
          'pull_request',
        ),
      ).toEqual({ ok: false, reason: `${job} is failure, the plan expects success` });
  });

  test('an unreadable plan output fails', () => {
    for (const name of ['app', 'sites', 'docs_only', 'profile'])
      for (const value of ['', 'yes', undefined]) {
        const outputs = { ...PLANS.quick, [name]: value };
        const { ok } = aggregate(
          needsFor('success', outputs, expected(PLANS.quick)),
          'pull_request',
        );
        expect({ name, value, ok }).toEqual({ name, value, ok: false });
      }
  });

  test('a docs-only plan that also selects other work fails', () => {
    for (const extra of [{ app: 'true' }, { sites: 'false' }]) {
      const outputs = { ...PLANS.docsOnly, ...extra };
      expect(aggregate(needsFor('success', outputs, expected(outputs)), 'pull_request').ok).toBe(
        false,
      );
    }
  });

  test('an unreadable needs context fails', () => {
    for (const needs of [undefined, null, '{}'])
      expect(aggregate(needs, 'pull_request').ok).toBe(false);
  });
});

describe('the CLI', () => {
  test('aggregate exits 0 only for a passing graph, and 1 for unparseable needs', () => {
    const graph = (results: Record<string, string>) =>
      JSON.stringify(needsFor('success', PLANS.docsOnly, results));
    expect(
      cli(['aggregate'], { EVENT: 'pull_request', NEEDS: graph(expected(PLANS.docsOnly)) }).status,
    ).toBe(0);
    expect(
      cli(['aggregate'], {
        EVENT: 'pull_request',
        NEEDS: graph({ ...expected(PLANS.docsOnly), service: 'success' }),
      }).status,
    ).toBe(1);
    expect(cli(['aggregate'], { EVENT: 'push', NEEDS: 'not json' }).status).toBe(1);
  });

  test('plan writes docs_only=false for a push, to GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-out-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    expect(cli(['plan'], { EVENT: 'push', GITHUB_OUTPUT: out }).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('docs_only=false\nreason=push keeps its plan\n');
    rmSync(dir, { recursive: true, force: true });
  });

  test('an unknown command exits 2', () => {
    expect(cli(['nope'], {}).status).toBe(2);
  });
});

interface StepEnv {
  EVENT: string;
  REF: string;
  CALLED: string;
  APP: string;
  WORKFLOWS: string;
  SITES: string;
  DOCS_ONLY: string;
}

/** The `changes` step's outputs before docs-only routing. */
function before(env: StepEnv) {
  let app = !['push', 'pull_request'].includes(env.EVENT);
  if (env.REF.startsWith('refs/tags/')) app = true;
  if (env.CALLED !== '' || env.APP === 'true' || env.WORKFLOWS === 'true') app = true;
  const sites = app || env.SITES === 'true';
  return { app: String(app), sites: String(sites), docs_only: 'false' };
}

describe('the workflow keeps its contract', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    expect({ name, found: start > -1 }).toEqual({ name, found: true });
    const rest = ci.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };

  /** The `changes` step of `plan`, run as the workflow would with the given environment. */
  const shellPlan = (env: StepEnv) => {
    const block = /- id: changes\n(?: {8}.*\n)*? {8}run: \|\n((?: {10}.*\n)+)/.exec(job('plan'));
    expect(block).not.toBeNull();
    const script = (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-shell-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    try {
      const run = spawnSync('sh', ['-eu', '-c', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, ...env },
      });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      return Object.fromEntries(
        readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const [key = '', value = ''] = line.split('=');
            return [key, value] as const;
          }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('the events are unchanged', () => {
    expect(ci).toMatch(
      /^name: checks\non:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}schedule:\n/,
    );
    expect(ci).toContain('  workflow_dispatch:\n');
    expect(ci).toContain('  workflow_call:\n');
  });

  test('a docs-only pull request runs only sites and docs-checks', () => {
    expect(
      shellPlan({
        EVENT: 'pull_request',
        REF: 'refs/pull/1/merge',
        CALLED: '',
        APP: 'true',
        WORKFLOWS: 'false',
        SITES: 'false',
        DOCS_ONLY: 'true',
      }),
    ).toEqual({ app: 'false', sites: 'true', docs_only: 'true' });
  });

  test('without docs-only the plan is what it was before', () => {
    const bools = ['true', 'false'];
    for (const EVENT of ['pull_request', 'push', 'schedule', 'workflow_dispatch'])
      for (const REF of ['refs/heads/main', 'refs/tags/v0.0.9'])
        for (const CALLED of ['', 'full'])
          for (const APP of bools)
            for (const WORKFLOWS of bools)
              for (const SITES of bools)
                for (const DOCS_ONLY of ['false', '', 'TRUE', 'true']) {
                  if (DOCS_ONLY === 'true' && EVENT === 'pull_request' && CALLED === '') continue;
                  const env = { EVENT, REF, CALLED, APP, WORKFLOWS, SITES, DOCS_ONLY };
                  expect({ env, plan: shellPlan(env) }).toEqual({ env, plan: before(env) });
                }
  });

  test('the classifier reads the pull request shas from a full clone and cannot fail the plan', () => {
    const body = job('plan');
    expect(body).toContain('fetch-depth: 0');
    expect(body).toContain('        id: docs\n        continue-on-error: true\n');
    expect(body).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(body).toContain('DOCS_ONLY: ${{ steps.docs.outputs.docs_only }}');
  });

  test('the jobs keep their gates, and the docs lane runs the same commands as service', () => {
    for (const name of ['package-build', 'a2a-peer-interop', 'service', 'tool-user'])
      expect(job(name)).toContain("    needs: plan\n    if: needs.plan.outputs.app == 'true'\n");
    expect(job('sites')).toContain("    needs: plan\n    if: needs.plan.outputs.sites == 'true'\n");
    expect(job('sites')).toContain('      - run: npm run sites:build\n');
    expect(job('ci-gate')).toContain(
      "    if: always() && !cancelled() && (needs.plan.result != 'success' || needs.plan.outputs.app == 'true')\n",
    );
    expect(job('docs-checks')).toContain(
      "    needs: plan\n    if: needs.plan.outputs.docs_only == 'true'\n",
    );
    expect(job('docs-checks')).toContain('      - run: npm run format:check\n');
    expect(job('docs-checks')).toContain(
      '      - run: npx vitest run test/unit/docs-reference.test.ts',
    );
    const acceptance = readFileSync(join(ROOT, 'scripts/acceptance.mjs'), 'utf8');
    expect(acceptance).toContain("await execute('format', 'npm', ['run', 'format:check']);");
    expect(job('check')).toContain('    if: ${{ !cancelled() }}\n');
    for (const name of ['plan', ...JOBS]) expect(job('check')).toContain(`        ${name},\n`);
  });

  test('the deploys and attestation are untouched: push to main only', () => {
    expect(job('certify')).toContain(
      "    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.plan.outputs.profile == 'full'\n",
    );
    expect(job('deploy-staging')).toContain(
      "    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.ci-gate.result == 'success'\n",
    );
  });
});
