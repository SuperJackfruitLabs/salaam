import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
// Operator ruling 2026-10-31: in full access a command runs without asking unless this check calls it
// dangerous. The check reads the command as a shell would, but only the plain subset: simple commands
// joined by && || ; |, quoted words and redirects to files. Anything else is "unparseable" and asks.
// Wrapper unwrapping (sudo, env, forced rm flags, the depth limit that fails closed) follows OpenAI
// Codex's codex-rs/shell-command/src/command_safety/is_dangerous_command.rs (Apache-2.0); the rule
// table extends it with the categories in the 2026-10-31 dangerous-command research.
export type DangerCategory =
  | 'unparseable'
  | 'depth'
  | 'shell-pipe'
  | 'destructive-files'
  | 'git-history'
  | 'publish'
  | 'credentials'
  | 'privilege'
  | 'system'
  | 'disk'
  | 'network'
  | 'process'
  | 'cloud'
  | 'database'
  | 'containers'
  | 'install-global'
  | 'outside-workspace';
export type DangerVerdict =
  | { dangerous: false }
  | { dangerous: true; category: DangerCategory; reason: string; segment: string };
export interface DangerContext {
  /** The workspace: writes inside it are ordinary. */
  root: string;
  home: string;
  /** Scratch directories writes may also go to. */
  tmp: string | string[];
}
export interface DangerRule {
  commands: string[];
  /** The first positional argument (after the command's own flags) must be one of these. */
  sub?: (string | RegExp)[];
  /** A further test on every argument after the command word. */
  test?: (args: string[]) => boolean;
  category: DangerCategory;
  why: string;
}
const MAX_DEPTH = 3;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun']);
const has = (args: string[], ...flags: string[]) =>
  args.some((a) => flags.some((f) => a === f || a.startsWith(f + '=')));
/** A short flag cluster containing this letter: -rf, -fr, -f. */
const short = (args: string[], letter: string) =>
  args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
const positional = (args: string[]) => args.filter((a) => !a.startsWith('-'));
/** git's own options before the subcommand, so `git -C dir push -f` reads as `push -f`. */
function gitArgs(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]!)) i++;
    i++;
  }
  return args.slice(i);
}
const git = (sub: string, test: (rest: string[]) => boolean) => (args: string[]) => {
  const [s, ...rest] = gitArgs(args);
  return s === sub && test(rest);
};
const sqlDestroys = (args: string[]) =>
  args.some(
    (a) => /\b(drop|truncate|alter)\b/i.test(a) || /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i.test(a),
  );
/** The built-in rules, checked against every simple command (wrappers unwrapped). */
export const DANGER_RULES: DangerRule[] = [
  // Privilege escalation
  {
    commands: ['sudo', 'su', 'doas', 'pkexec'],
    category: 'privilege',
    why: 'runs as another user, usually root',
  },
  {
    commands: ['chmod'],
    test: (a) =>
      a.some((x) => /(^|[ugoa,])\+?[ugoa]*\+[rwx]*s|^[2467][0-7]{3}$/.test(x)) ||
      ((short(a, 'R') || has(a, '--recursive')) && a.includes('777')),
    category: 'privilege',
    why: 'sets setuid/setgid or makes a tree world-writable',
  },
  {
    commands: ['chown', 'chgrp'],
    test: (a) => a.some((x) => /^root(:|$)/.test(x)),
    category: 'privilege',
    why: 'gives files to root',
  },
  // Destructive file operations
  {
    commands: ['rm'],
    test: (a) =>
      short(a, 'r') ||
      short(a, 'R') ||
      short(a, 'f') ||
      has(a, '--force', '--recursive') ||
      positional(a).some((p) => ['/', '*', '.', '..', '~'].includes(p)),
    category: 'destructive-files',
    why: 'deletes recursively or by force, with no undo',
  },
  {
    commands: ['shred', 'srm', 'wipe'],
    category: 'destructive-files',
    why: 'overwrites files so they cannot be recovered',
  },
  {
    commands: ['truncate'],
    category: 'destructive-files',
    why: 'cuts files to a size, losing their contents',
  },
  {
    commands: ['find'],
    test: (a) => a.includes('-delete'),
    category: 'destructive-files',
    why: 'find -delete removes every match',
  },
  // Git history and remotes
  {
    commands: ['git'],
    test: (a) => a.slice(0, a.length - gitArgs(a).length).some((x) => x === '-c'),
    category: 'git-history',
    why: 'git -c can set a command git will run (sshCommand, hooks, aliases)',
  },
  {
    commands: ['git'],
    test: git(
      'push',
      (r) =>
        has(r, '--force', '--force-with-lease', '--delete', '--mirror', '--prune') ||
        short(r, 'f') ||
        short(r, 'd') ||
        r.some((x) => /^[+:]/.test(x)),
    ),
    category: 'git-history',
    why: 'rewrites or deletes history on the remote',
  },
  {
    commands: ['git'],
    test: git('reset', (r) => has(r, '--hard', '--merge', '--keep')),
    category: 'git-history',
    why: 'discards uncommitted work',
  },
  {
    commands: ['git'],
    test: git('clean', (r) => short(r, 'f') || has(r, '--force')),
    category: 'git-history',
    why: 'deletes untracked files',
  },
  {
    commands: ['git'],
    test: git('branch', (r) => short(r, 'D') || (has(r, '--delete') && has(r, '--force'))),
    category: 'git-history',
    why: 'deletes a branch that may not be merged',
  },
  {
    commands: ['git'],
    test: git('tag', (r) => short(r, 'd') || has(r, '--delete')),
    category: 'git-history',
    why: 'deletes a tag',
  },
  {
    commands: ['git'],
    test: git(
      'checkout',
      (r) => r.includes('--') || r.includes('.') || short(r, 'f') || has(r, '--force'),
    ),
    category: 'git-history',
    why: 'overwrites uncommitted changes in the working tree',
  },
  {
    commands: ['git'],
    test: git('restore', (r) => !has(r, '--staged') || has(r, '--worktree')),
    category: 'git-history',
    why: 'discards uncommitted changes',
  },
  {
    commands: ['git'],
    test: git('stash', (r) => ['drop', 'clear'].includes(r[0] ?? '')),
    category: 'git-history',
    why: 'drops stashed work',
  },
  {
    commands: ['git'],
    test: git('rm', (r) => short(r, 'f') || short(r, 'r') || has(r, '--force')),
    category: 'git-history',
    why: 'removes tracked files',
  },
  {
    commands: ['git'],
    test: (a) => {
      const [s, ...r] = gitArgs(a);
      return (
        ['rebase', 'filter-branch', 'filter-repo'].includes(s ?? '') ||
        (s === 'reflog' && r[0] === 'expire') ||
        (s === 'gc' && r.some((x) => x.startsWith('--prune'))) ||
        (s === 'update-ref' && short(r, 'd'))
      );
    },
    category: 'git-history',
    why: 'rewrites or expires history',
  },
  // Publishing, releases, deploys
  {
    commands: ['npm', 'pnpm', 'yarn', 'bun'],
    sub: ['publish', 'unpublish', 'deprecate'],
    category: 'publish',
    why: 'publishes a package to a public registry',
  },
  {
    commands: ['cargo', 'gem', 'twine'],
    sub: ['publish', 'push', 'upload', 'yank'],
    category: 'publish',
    why: 'publishes a package to a public registry',
  },
  {
    commands: ['docker', 'podman'],
    sub: ['push'],
    category: 'publish',
    why: 'pushes an image to a registry',
  },
  {
    commands: ['gh', 'tea'],
    test: (a) =>
      /^(release (create|delete|upload|edit)|pr merge|repo (delete|archive|edit|rename)|secret (set|delete)|api)\b/.test(
        positional(a).slice(0, 2).join(' '),
      ),
    category: 'publish',
    why: 'changes a release, repository or merge on the forge',
  },
  {
    commands: ['wrangler'],
    sub: ['deploy', 'publish', 'delete', 'rollback', 'secret', 'versions'],
    category: 'publish',
    why: 'deploys or changes a live Worker',
  },
  {
    commands: ['fly', 'flyctl', 'netlify', 'vercel', 'railway', 'heroku'],
    test: (a) =>
      /^(deploy|destroy|up|release|promote)/.test(positional(a)[0] ?? '') || has(a, '--prod'),
    category: 'publish',
    why: 'deploys to a live environment',
  },
  {
    commands: ['terraform', 'tofu', 'pulumi'],
    sub: ['apply', 'destroy', 'up', 'import', 'state'],
    category: 'publish',
    why: 'changes real infrastructure',
  },
  // Credentials
  {
    commands: ['security'],
    sub: [/^(find-.*-password|dump-keychain|export|delete-)/],
    category: 'credentials',
    why: 'reads or changes the keychain',
  },
  {
    commands: ['gpg'],
    test: (a) => has(a, '--export-secret-keys', '--export-secret-subkeys'),
    category: 'credentials',
    why: 'exports private keys',
  },
  {
    commands: ['ssh-add', 'ssh-keygen', 'ssh-agent'],
    category: 'credentials',
    why: 'loads or writes SSH keys',
  },
  {
    commands: ['gh'],
    test: (a) => positional(a).slice(0, 2).join(' ') === 'auth token',
    category: 'credentials',
    why: 'prints a forge token',
  },
  {
    commands: ['printenv'],
    category: 'credentials',
    why: 'prints the environment, which may hold secrets',
  },
  // System configuration and persistence
  {
    commands: ['systemctl'],
    test: (a) =>
      !/^(status|is-active|is-enabled|list-.*|show|cat)$/.test(positional(a)[0] ?? 'status'),
    category: 'system',
    why: 'changes system services',
  },
  {
    commands: ['launchctl'],
    sub: [/^(load|unload|bootstrap|bootout|kickstart|enable|disable|remove|submit|setenv)$/],
    category: 'system',
    why: 'changes launch agents or daemons',
  },
  {
    commands: ['crontab'],
    test: (a) => !(a.length === 1 && a[0] === '-l'),
    category: 'system',
    why: 'changes scheduled jobs',
  },
  {
    commands: ['defaults'],
    sub: ['write', 'delete', 'import'],
    category: 'system',
    why: 'changes macOS preferences',
  },
  {
    commands: [
      'scutil',
      'networksetup',
      'pfctl',
      'iptables',
      'ip6tables',
      'nft',
      'ufw',
      'nvram',
      'csrutil',
      'spctl',
      'tccutil',
      'systemsetup',
    ],
    category: 'system',
    why: 'changes host network or security settings',
  },
  {
    commands: ['sysctl'],
    test: (a) => short(a, 'w') || a.some((x) => x.includes('=')),
    category: 'system',
    why: 'changes kernel settings',
  },
  // Disks and volumes
  {
    commands: [
      'dd',
      'fdisk',
      'sfdisk',
      'parted',
      'gdisk',
      'wipefs',
      'mount',
      'umount',
      'swapoff',
      'losetup',
    ],
    category: 'disk',
    why: 'writes to or remounts disks',
  },
  { commands: ['mkfs', 'newfs'], category: 'disk', why: 'formats a volume' },
  {
    commands: ['diskutil'],
    sub: [/^(erase|partition|zero|random|secureErase|unmount|eject|apfs|reformat|resize)/i],
    category: 'disk',
    why: 'erases, repartitions or unmounts a disk',
  },
  {
    commands: ['hdiutil'],
    sub: ['detach', 'eject', 'resize', 'compact'],
    category: 'disk',
    why: 'detaches or resizes a disk image',
  },
  {
    commands: ['tmutil'],
    sub: ['delete', 'disable', 'deletelocalsnapshots'],
    category: 'disk',
    why: 'deletes backups',
  },
  // Network: data leaving the machine, or remote control
  {
    commands: [
      'ssh',
      'scp',
      'sftp',
      'nc',
      'ncat',
      'netcat',
      'socat',
      'telnet',
      'ngrok',
      'cloudflared',
    ],
    category: 'network',
    why: 'connects to another host or opens a tunnel',
  },
  {
    commands: ['rsync'],
    test: (a) => positional(a).some((p) => /^[^/]*:/.test(p)),
    category: 'network',
    why: 'copies files to or from another host',
  },
  {
    commands: ['curl'],
    test: (a) =>
      has(a, '-T', '--upload-file', '-F', '--form') ||
      a.some((x, i) => /^(-d|--data.*)$/.test(x) && a[i + 1]?.startsWith('@')) ||
      a.some((x) => /^-d@/.test(x)),
    category: 'network',
    why: 'uploads a local file',
  },
  {
    commands: ['wget'],
    test: (a) => has(a, '--post-file', '--body-file'),
    category: 'network',
    why: 'uploads a local file',
  },
  // Processes and the host
  {
    commands: ['killall', 'pkill'],
    category: 'process',
    why: 'kills processes by name, including ones this session did not start',
  },
  {
    commands: ['kill'],
    test: (a) => a.includes('-1') || positional(a).some((p) => p === '1' || p === '0'),
    category: 'process',
    why: 'signals every process or init',
  },
  {
    commands: ['shutdown', 'reboot', 'halt', 'poweroff'],
    category: 'process',
    why: 'stops the machine',
  },
  // Cloud and clusters
  {
    commands: ['aws'],
    test: (a) => positional(a).some((p) => /^(rm|rb|delete-.*|terminate-.*|remove-.*)$/.test(p)),
    category: 'cloud',
    why: 'deletes cloud resources',
  },
  {
    commands: ['gcloud', 'az', 'doctl', 'hcloud'],
    test: (a) => positional(a).some((p) => /^(delete|destroy|remove)$/.test(p)),
    category: 'cloud',
    why: 'deletes cloud resources',
  },
  {
    commands: ['kubectl', 'oc'],
    sub: ['delete', 'drain', 'cordon', 'apply', 'replace', 'scale', 'patch'],
    category: 'cloud',
    why: 'changes a cluster',
  },
  {
    commands: ['helm'],
    sub: ['uninstall', 'delete', 'rollback', 'upgrade', 'install'],
    category: 'cloud',
    why: 'changes a cluster release',
  },
  {
    commands: ['tailscale'],
    sub: ['down', 'logout', 'up', 'set'],
    category: 'cloud',
    why: 'changes this machine’s tailnet',
  },
  // Databases
  { commands: ['dropdb', 'dropuser'], category: 'database', why: 'drops a database' },
  {
    commands: ['redis-cli'],
    test: (a) => a.some((x) => /^flush(all|db)$/i.test(x)),
    category: 'database',
    why: 'erases a Redis database',
  },
  {
    commands: ['psql', 'mysql', 'mariadb', 'sqlite3', 'mongosh', 'mongo', 'clickhouse-client'],
    test: sqlDestroys,
    category: 'database',
    why: 'drops, truncates or deletes without WHERE',
  },
  {
    commands: ['prisma'],
    test: (a) => positional(a).join(' ').startsWith('migrate reset') || has(a, '--force-reset'),
    category: 'database',
    why: 'resets the database',
  },
  {
    commands: ['rails', 'rake'],
    sub: [/^db:(drop|reset|purge|schema:load)/],
    category: 'database',
    why: 'drops or resets the database',
  },
  // Containers
  {
    commands: ['docker', 'podman'],
    test: (a) => {
      const p = positional(a).join(' ');
      return (
        (/^(system|volume|image|container|network|builder) prune|^(volume|network) rm|^rmi\b|^compose down/.test(
          p,
        ) &&
          (!p.startsWith('compose') || short(a, 'v') || has(a, '--volumes'))) ||
        (/^rm\b/.test(p) && (short(a, 'f') || has(a, '--force'))) ||
        has(a, '--privileged', '--pid', '--cap-add', '--security-opt') ||
        a.some((x, i) => (x === '-v' || x === '--volume') && /^\/(:|$)/.test(a[i + 1] ?? ''))
      );
    },
    category: 'containers',
    why: 'removes containers, images or volumes, or gives a container the host',
  },
  // Installs that change the machine rather than the workspace
  {
    commands: ['npm', 'pnpm', 'bun'],
    test: (a) =>
      /^(i|install|add|update|uninstall|remove|link)$/.test(positional(a)[0] ?? '') &&
      (short(a, 'g') || has(a, '--global', '--location')),
    category: 'install-global',
    why: 'installs or removes a global package',
  },
  {
    commands: ['yarn'],
    sub: ['global'],
    category: 'install-global',
    why: 'installs a global package',
  },
  {
    commands: ['pip', 'pip3'],
    test: (a) => has(a, '--break-system-packages', '--user', '--target', '--prefix'),
    category: 'install-global',
    why: 'installs outside a virtual environment',
  },
  {
    commands: ['brew', 'port'],
    sub: [
      'install',
      'uninstall',
      'reinstall',
      'upgrade',
      'remove',
      'tap',
      'untap',
      'link',
      'unlink',
      'services',
    ],
    category: 'install-global',
    why: 'changes system packages',
  },
  {
    commands: ['apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk', 'zypper', 'snap', 'dpkg', 'rpm'],
    category: 'install-global',
    why: 'changes system packages',
  },
];
/** Commands that write their path arguments, checked for paths outside the workspace. */
const WRITERS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'mv',
  'cp',
  'ln',
  'tee',
  'install',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'shred',
  'rsync',
  'ditto',
  'patch',
]);
const IN_PLACE = new Set(['sed', 'perl', 'gsed']);
/** Wrappers whose real command is the rest of argv, after their own options. */
const WRAPPERS: Record<string, (args: string[]) => string[] | null> = {
  env: (a) => {
    let i = 0;
    while (
      i < a.length &&
      (a[i] === '-i' ||
        a[i] === '--ignore-environment' ||
        a[i] === '-u' ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[i]!) ||
        a[i - 1] === '-u')
    )
      i++;
    if (a[i] === '--') i++;
    return a.slice(i);
  },
  timeout: (a) => {
    let i = 0;
    while (i < a.length && a[i]!.startsWith('-'))
      i += ['-s', '-k', '--signal', '--kill-after'].includes(a[i]!) ? 2 : 1;
    return a.slice(i + 1);
  },
  nice: (a) => (a[0] === '-n' ? a.slice(2) : /^-\d+$/.test(a[0] ?? '') ? a.slice(1) : a),
  nohup: (a) => a,
  time: (a) => a.filter((x, i) => !(x.startsWith('-') && i === 0)),
  command: (a) => (a[0] === '-p' ? a.slice(1) : a[0] === '-v' || a[0] === '-V' ? [] : a),
  builtin: (a) => a,
  exec: (a) => a.filter((x, i) => !(i === 0 && x.startsWith('-'))),
  stdbuf: (a) => a.slice(a.findIndex((x) => !x.startsWith('-'))),
  caffeinate: (a) =>
    a.slice(
      Math.max(
        0,
        a.findIndex((x) => !x.startsWith('-')),
      ),
    ),
  xargs: (a) => {
    let i = 0;
    while (i < a.length && a[i]!.startsWith('-')) i += /^-[nIPLdsEa]$/.test(a[i]!) ? 2 : 1;
    return a.slice(i);
  },
};
interface Segment {
  argv: string[];
  afterPipe: boolean;
  redirects: { out: boolean; target: string }[];
  text: string;
}
class Unparseable extends Error {}
const SAFE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
/** Splits the plain subset of shell into simple commands, or throws Unparseable. */
function parse(command: string, home: string): Segment[] {
  const segments: Segment[] = [];
  let seg: Segment = { argv: [], afterPipe: false, redirects: [], text: '' };
  let start = 0,
    word = '',
    inWord = false,
    redirect: { out: boolean } | null = null;
  const endWord = () => {
    if (!inWord) return;
    if (/^~(\/|$)/.test(word)) word = home + word.slice(1);
    else if (word.startsWith('~')) throw new Unparseable('~user paths are not read');
    if (/[{}]/.test(word) && word !== '{}') throw new Unparseable('brace expansion is not read');
    if (redirect) {
      seg.redirects.push({ out: redirect.out, target: word });
      redirect = null;
    } else seg.argv.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = (end: number, pipe: boolean) => {
    endWord();
    if (redirect) throw new Unparseable('a redirect has no target');
    seg.text = command.slice(start, end).trim();
    if (seg.argv.length) segments.push(seg);
    else if (pipe || seg.afterPipe || seg.redirects.length)
      throw new Unparseable('an empty command');
    seg = { argv: [], afterPipe: pipe, redirects: [], text: '' };
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Unparseable('an unclosed quote');
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) throw new Unparseable('an unclosed quote');
      const inner = command.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) throw new Unparseable('expansion inside double quotes');
      word += inner;
      inWord = true;
      i = end;
    } else if (ch === ' ' || ch === '\t') endWord();
    else if (ch === '\n' || ch === ';') {
      endSegment(i, false);
      start = i + 1;
    } else if (ch === '&' && command[i + 1] === '&') {
      endSegment(i, false);
      start = ++i + 1;
    } else if (ch === '|' && command[i + 1] === '|') {
      endSegment(i, false);
      start = ++i + 1;
    } else if (ch === '|') {
      if (command[i + 1] === '&') throw new Unparseable('|& is not read');
      endSegment(i, true);
      start = i + 1;
    } else if (ch === '>' || ch === '<' || (ch === '&' && command[i + 1] === '>')) {
      // An fd number directly before the operator belongs to it: 2>&1, 2>/dev/null.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else endWord();
      if (redirect) throw new Unparseable('a redirect has no target');
      if (ch === '&') i++;
      const out = command[i] === '>';
      if (!out && command[i + 1] === '<') throw new Unparseable('a heredoc or here-string');
      if (command[i + 1] === '(' || (!out && command[i + 1] === '>'))
        throw new Unparseable('process substitution');
      if (out && command[i + 1] === '>') i++;
      if (out && command[i + 1] === '&') {
        const m = /^&(\d+|-)/.exec(command.slice(i + 1));
        if (!m) throw new Unparseable('a redirect it cannot read');
        i += m[0].length;
        continue;
      }
      redirect = { out };
    } else if ('$`\\()&#'.includes(ch) && !(ch === '#' && inWord))
      throw new Unparseable(
        ch === '$' || ch === '`'
          ? 'command or variable substitution'
          : ch === '&'
            ? 'a background job'
            : ch === '\\'
              ? 'an escaped character'
              : ch === '#'
                ? 'a comment'
                : 'a subshell',
      );
    else {
      word += ch;
      inWord = true;
    }
  }
  endSegment(command.length, false);
  return segments;
}
const yes = (category: DangerCategory, reason: string, segment: string): DangerVerdict => ({
  dangerous: true,
  category,
  reason,
  segment,
});
const CREDENTIAL_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.kube',
  '.docker',
  '.netrc',
  'Library/Keychains',
  '.config/gcloud',
  '.azure',
  '.npmrc',
  '.pypirc',
];
/** Where a path really lands: symlinks in its existing part resolved, the rest kept as written. */
function real(p: string): string {
  for (let head = p, tail = ''; ;) {
    try {
      return tail ? join(realpathSync(head), tail) : realpathSync(head);
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      tail = tail ? join(basename(head), tail) : basename(head);
      head = up;
    }
  }
}
function credentialPath(abs: string, home: string): boolean {
  const name = basename(abs);
  return (
    /^\.env(\.|$)/.test(name) ||
    /\.(pem|key|p12|pfx)$/.test(name) ||
    /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/.test(name) ||
    CREDENTIAL_DIRS.some((d) => abs === home + sep + d || abs.startsWith(home + sep + d + sep))
  );
}
/** Whether a command (as the model wrote it) is dangerous to run without asking, and why. */
export function classifyCommand(command: string, ctx: DangerContext): DangerVerdict {
  return classify(command, ctx, 0, command);
}
function classify(
  command: string,
  ctx: DangerContext,
  depth: number,
  outer: string,
): DangerVerdict {
  let segments: Segment[];
  try {
    segments = parse(command, ctx.home);
  } catch (error) {
    if (!(error instanceof Unparseable)) throw error;
    return yes(
      'unparseable',
      `the check cannot read ${error.message}, so it cannot see what will run`,
      depth ? outer : command.trim(),
    );
  }
  for (const s of segments) {
    const v = simple(s.argv, s, ctx, depth, depth ? outer : s.text);
    if (v.dangerous) return v;
  }
  return { dangerous: false };
}
function simple(
  argv: string[],
  s: Segment,
  ctx: DangerContext,
  depth: number,
  text: string,
): DangerVerdict {
  const tmps = Array.isArray(ctx.tmp) ? ctx.tmp : [ctx.tmp];
  // Operator ruling 2026-10-31: paths are checked where they really land, through symlinks.
  const abs = (p: string) => real(resolve(ctx.root, p));
  const roots = [ctx.root, ...tmps].map(real);
  const inside = (p: string) =>
    roots.some((r) => p === r || p.startsWith(r + sep)) || SAFE_TARGETS.has(p);
  for (const r of s.redirects) {
    const p = abs(r.target);
    if (credentialPath(p, ctx.home) || credentialPath(p, real(ctx.home)))
      return yes('credentials', `reads or writes a credential file (${r.target})`, text);
    if (r.out && !inside(p))
      return yes('outside-workspace', `writes ${r.target}, outside this workspace`, text);
  }
  let i = 0;
  for (; i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!); i++)
    if (/^(LD_|DYLD_|BASH_ENV=|ENV=|PROMPT_COMMAND=)/.test(argv[i]!))
      return yes(
        'privilege',
        `${argv[i]!.split('=')[0]} makes every program load other code`,
        text,
      );
  argv = argv.slice(i);
  if (!argv.length) return { dangerous: false };
  const cmd = basename(argv[0]!),
    args = argv.slice(1);
  if (/[^\x21-\x7e]/.test(argv[0]!))
    return yes('unparseable', 'the command name has hidden or non-ASCII characters', text);
  if (cmd === 'eval' || cmd === 'source' || cmd === '.')
    return yes('unparseable', `${cmd} runs text the check cannot read`, text);
  if (
    s.afterPipe &&
    (SHELLS.has(cmd) || (INTERPRETERS.has(cmd) && !positional(args).some((p) => p !== '-')))
  )
    return yes('shell-pipe', `pipes text into ${cmd}, which runs it as code`, text);
  for (const rule of DANGER_RULES) {
    if (
      !rule.commands.includes(cmd) &&
      !(rule.commands.includes('mkfs') && cmd.startsWith('mkfs.'))
    )
      continue;
    if (
      rule.sub &&
      !rule.sub.some((m) =>
        typeof m === 'string' ? m === positional(args)[0] : m.test(positional(args)[0] ?? ''),
      )
    )
      continue;
    if (rule.test && !rule.test(args)) continue;
    return yes(rule.category, `${cmd}: ${rule.why}`, text);
  }
  const inner = (next: string[]): DangerVerdict =>
    depth + 1 > MAX_DEPTH
      ? yes('depth', `wrapped more than ${MAX_DEPTH} levels deep, so the check stops reading`, text)
      : simple(next, { ...s, redirects: [] }, ctx, depth + 1, text);
  if (SHELLS.has(cmd)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c >= 0) {
      if (depth + 1 > MAX_DEPTH)
        return yes(
          'depth',
          `wrapped more than ${MAX_DEPTH} levels deep, so the check stops reading`,
          text,
        );
      return classify(args[c + 1] ?? '', ctx, depth + 1, text);
    }
  }
  if (cmd === 'find') {
    const at = args.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a));
    if (at >= 0) {
      const rest = args.slice(at + 1),
        end = rest.findIndex((a) => a === ';' || a === '+');
      return inner(end < 0 ? rest : rest.slice(0, end));
    }
  }
  const wrapper = WRAPPERS[cmd];
  if (wrapper) {
    const next = wrapper(args);
    if (next === null || !next.length)
      return cmd === 'env'
        ? yes('credentials', 'env prints the environment, which may hold secrets', text)
        : { dangerous: false };
    return inner(next);
  }
  const paths = positional(args).map(abs);
  const cred = paths.find((p) => credentialPath(p, ctx.home) || credentialPath(p, real(ctx.home)));
  if (cred) return yes('credentials', `touches a credential file (${cred})`, text);
  const writes =
    WRITERS.has(cmd) ||
    (IN_PLACE.has(cmd) && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')));
  if (writes) {
    const out = paths.find((p) => !inside(p));
    if (out) return yes('outside-workspace', `${cmd} writes ${out}, outside this workspace`, text);
  }
  return { dangerous: false };
}
