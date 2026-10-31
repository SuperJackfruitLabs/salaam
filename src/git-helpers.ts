import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Phase 4a git helpers for desk sessions. /commit, /branch and /pr are instructions to the model:
// every git command they lead to goes through the session's normal command approval and sandbox.
// Operator ruling 2026-10-31: pushing and opening a pull request ask in every mode except YOLO.

/** Why a command publishes to a remote, or null. Read from the raw text on purpose: a push hidden in
 * a substitution, `sh -c` or a compound command still counts, and a false match only asks. */
export function publishesToRemote(command: string): string | null {
  for (const part of command.split(/&&|\|\||[;|\n]|\$\(|`/)) {
    const words = part.replace(/["']/g, ' ').trim().split(/\s+/);
    const at = words.findIndex((w) => /(^|\/)(git|gh|tea)$/.test(w));
    if (at < 0) continue;
    const tool = words[at]!.split('/').pop()!;
    const rest = words.slice(at + 1).filter((w) => !w.startsWith('-'));
    if (tool === 'git') {
      // git's own options take a value: -C dir, -c key=value.
      const args = words.slice(at + 1);
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-'))
        i += ['-C', '-c'].includes(args[i]!) ? 2 : 1;
      if (args[i] === 'push') return 'pushes commits to a remote';
    } else if (/^(pr|pulls)$/.test(rest[0] ?? '') && rest[1] === 'create')
      return 'opens a pull request on the forge';
  }
  return null;
}

/** The author and committer git would use here, from the person's own git config (repo, global and
 * system), so a sandboxed command that cannot read ~/.gitconfig still commits as them. Empty when
 * either the name or the email is missing: Salaam never invents an identity. */
export function gitIdentityEnv(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const read = (key: string) => {
    try {
      return execFileSync('git', ['config', '--get', key], {
        cwd: root,
        encoding: 'utf8',
        timeout: 2000,
        env: { ...env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  };
  const name = read('user.name'),
    email = read('user.email');
  if (!name || !email || /[\0\n]/.test(name + email)) return {};
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** git check-ref-format --branch, plus nothing a shell would read specially. */
export function validBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !/^[-./]|\/$|\.\.|\/\/|\/\.|\.lock(\/|$)|\.$/.test(name) &&
    name !== '@'
  );
}

export interface GitPrefs {
  trailers: string[];
  sessionTrailer: boolean;
}
export const GIT_PREFS_PATH = join(homedir(), '.config', 'salaam', 'git.json');
/** Per-person commit trailers: {"trailers": ["Key: value"], "session_trailer": true}. */
export function loadGitPrefs(path = GIT_PREFS_PATH): GitPrefs {
  let raw: { trailers?: unknown; session_trailer?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { trailers: [], sessionTrailer: false };
  }
  const trailers = Array.isArray(raw.trailers)
    ? raw.trailers.filter(
        (t): t is string => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9-]*: [^\n\r]+$/.test(t),
      )
    : [];
  return { trailers, sessionTrailer: raw.session_trailer === true };
}

const RULES =
  'Never use --amend, rebase, reset or force anything, never pass --no-verify, and never change git config or hooks.';

export function commitInstruction(o: GitPrefs & { session: string }): string {
  const trailers = [...o.trailers, ...(o.sessionTrailer ? [`Salaam-Session: ${o.session}`] : [])];
  return [
    'Commit the current work.',
    'Run git status and git diff (staged and unstaged) to see what changed.',
    'Stage only the files that belong to this change, by path with git add; leave unrelated or generated files alone and say which you left.',
    'Write a commit message in this repository’s style (read git log --oneline -10): a short subject, a blank line, then a body saying why.',
    trailers.length
      ? `End the message with exactly these trailer lines:\n${trailers.join('\n')}`
      : 'Add no trailer lines.',
    'Commit with git commit -F and a message file in the system temp directory, so the approval shows the exact message. The author comes from the person’s own git config; do not set one.',
    RULES,
  ].join('\n');
}

export function branchInstruction(name: string): string {
  if (!validBranchName(name)) throw new Error(`"${name}" is not a valid git branch name.`);
  return [
    `Switch to branch ${name}: run git switch ${name} if it exists (git branch --list ${name}), otherwise git switch -c ${name}.`,
    'If there are uncommitted changes that would be overwritten, stop and tell me instead of forcing.',
    RULES,
  ].join('\n');
}

export function prInstruction(o: {
  tool: 'gh' | 'tea' | null;
  branch: string;
  base: string;
}): string {
  if (!o.tool) throw new Error('/pr needs gh or tea on this machine to open a pull request.');
  const create =
    o.tool === 'gh'
      ? `gh pr create --base ${o.base} --head ${o.branch} --title <title> --body-file <file>`
      : `tea pr create --base ${o.base} --head ${o.branch} --title <title> --description <body>`;
  return [
    `Open a pull request for ${o.branch} into ${o.base}.`,
    `Read git log ${o.base}..HEAD and git diff ${o.base}...HEAD, then draft a title and a body: what changed, why, and how it was tested.`,
    `Push the branch with git push -u origin ${o.branch}; never use --force or any push option that rewrites the remote.`,
    `Then open it with ${create}, writing the body to a file in the system temp directory.`,
    'Pushing and opening the pull request each ask for approval; show the drafted title and body before asking.',
    RULES,
  ].join('\n');
}

function gitOut(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
/** The checked-out branch, or null when detached. */
export const currentBranch = (root: string) => gitOut(root, ['branch', '--show-current']) || null;
/** The remote's default branch (origin/HEAD), else main. */
export function defaultBase(root: string): string {
  const ref = gitOut(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return ref?.replace(/^origin\//, '') || 'main';
}

/** Which forge CLI opens pull requests here: gh for GitHub remotes, tea otherwise, if installed. */
export function forgeTool(root: string): 'gh' | 'tea' | null {
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const url = run('git', ['remote', 'get-url', 'origin']) ?? '';
  const has = (cmd: string) => run(cmd, ['--version']) !== null;
  if (/github\.com[:/]/.test(url)) return has('gh') ? 'gh' : null;
  return has('tea') ? 'tea' : has('gh') ? 'gh' : null;
}
