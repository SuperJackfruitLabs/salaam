import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { trustedMainRun } from './release-source.mjs';

export function deploymentDecision({ eventName, event, repository, commit, main, run, ref }) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(main))
    throw Error('Missing source identity');
  if (eventName === 'workflow_run') {
    if (event.workflow_run?.id !== run?.id || event.workflow_run?.head_sha !== commit)
      throw Error('Deployment does not match the completed CI event');
  } else if (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main') {
    throw Error('Only completed main CI or a manual main retry may deploy');
  }
  if (
    !run ||
    !trustedMainRun(run, repository, commit) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw Error('Successful push CI on this repository main is required');
  return {
    deploy: commit === main,
    commit,
    ci_run_id: run.id,
    reason: commit === main ? 'Successful current main CI' : 'Superseded by newer main source',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw Error('Missing repository');
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });
  const api = (path) => JSON.parse(gh('api', path));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const main = api(`repos/${repository}/git/ref/heads/main`).object.sha;
  const run =
    eventName === 'workflow_run'
      ? api(`repos/${repository}/actions/runs/${event.workflow_run.id}`)
      : api(
          `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&branch=main&per_page=100`,
        )
          .workflow_runs.filter((r) => trustedMainRun(r, repository, commit))
          .sort((a, b) => b.id - a.id)[0];
  const decision = deploymentDecision({
    eventName,
    event,
    repository,
    commit,
    main,
    run,
    ref: process.env.GITHUB_REF,
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${decision.deploy}\n`);
  mkdirSync('.state', { recursive: true });
  writeFileSync('.state/sites-deployment-target.json', JSON.stringify(decision, null, 2) + '\n');
  console.log(JSON.stringify(decision));
}
