import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROOF_ROUNDS = 20;
export const PROOF_SHARDS = 4;
export const proofs = {
  S1: 'session-attach',
  S2: 'approval-correlation',
  S3: 'effect-recovery',
  S4: 'child-result-recovery',
  S5: 'context-compaction',
  S6: 'required-capabilities',
};
export const portfolios = {
  operators: [
    'test/proofs/tui-terminal.test.ts',
    'test/proofs/tui-client.test.ts',
    'test/proofs/operator-coding.test.ts',
  ],
  tasks: [
    'test/proofs/task-recovery.test.ts',
    'test/proofs/task-completion.test.ts',
    'test/proofs/task-lifecycle.test.ts',
    'test/proofs/task-gates.test.ts',
  ],
  jobs: [
    'test/proofs/job-recovery.test.ts',
    'test/proofs/job-terminal.test.ts',
    'test/unit/schedules.test.ts',
    'test/unit/recurring.test.ts',
    'test/unit/operator-inbox.test.ts',
    'test/unit/host.test.ts',
  ],
};
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function sourceIdentity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sources = git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean)
    .sort()
    .map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) }));
  return {
    git_commit: git('rev-parse', 'HEAD'),
    working_tree_dirty: Boolean(git('status', '--porcelain')),
    sources,
    source_digest: hash(JSON.stringify(sources)),
  };
}
export function acceptancePlan(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--profile', '--repeats', '--shard'].includes(key) ||
      options[key] !== undefined ||
      !args[i + 1]
    )
      throw Error('Use --profile full|quick|baseline|proofs, --repeats N, --shard I/N');
    options[key] = args[i + 1];
  }
  const profile = options['--profile'] ?? 'full';
  if (!['full', 'quick', 'baseline', 'proofs'].includes(profile))
    throw Error('Unknown acceptance profile');
  if (options['--repeats'] !== undefined && profile !== 'full')
    throw Error('--repeats is only for the full local profile');
  const rounds =
    profile === 'quick'
      ? 1
      : profile === 'baseline'
        ? 0
        : Number(options['--repeats'] ?? PROOF_ROUNDS);
  if (profile === 'full' && (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100))
    throw Error('--repeats must be 1–100');
  if (options['--shard'] && profile !== 'proofs') throw Error('Only proof rounds can be sharded');
  const match = /^(\d+)\/(\d+)$/.exec(options['--shard'] ?? '1/1');
  if (!match) throw Error('Invalid shard');
  const index = Number(match[1]),
    count = Number(match[2]);
  if (count < 1 || count > PROOF_ROUNDS || index < 1 || index > count || PROOF_ROUNDS % count)
    throw Error('Invalid shard');
  const iterations = Array.from({ length: rounds }, (_, i) => i + 1).filter(
    (i) =>
      profile !== 'proofs' || (i > ((index - 1) * rounds) / count && i <= (index * rounds) / count),
  );
  return {
    profile,
    rounds,
    iterations,
    shard: profile === 'proofs' ? { index, count } : null,
    baseline: profile !== 'proofs',
    portfolioRepeats: profile === 'proofs' ? 0 : profile === 'quick' ? 1 : 3,
  };
}
