import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  readdirSync,
  opendirSync,
  rmdirSync,
  lstatSync,
  fstatSync,
  realpathSync,
  renameSync,
  unlinkSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, ServiceError, string, integer } from '../core/index.js';
import type { Store, Artifacts } from '../store/index.js';
import type { WorkspaceTree } from '../core/index.js';

export const WORKSPACE_LIMITS = {
  entries: 2048,
  revisions: 32,
  files: 512,
  bytes: 4 * 1024 * 1024,
  fileBytes: 256 * 1024,
  outputBytes: 16 * 1024,
} as const;
export interface Workspace {
  id: string;
  session_id: string;
  source: string;
  root: string;
  revision: number;
  digest: string;
  baseline: string;
  state: 'ready' | 'conflict';
}
interface Mutation {
  id: string;
  workspace_id: string;
  request_key: string;
  input_digest: string;
  expected_revision: number;
  before_digest: string;
  after_digest: string;
  artifact_id: string;
  before_root: string;
  after_root: string;
  state: string;
  error: string | null;
}
export function filePath(value: unknown): string {
  const path = string(value, 'path', 512);
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.split('/').length > 16 ||
    path
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || /^\.(git|salaam)(?:$|[.-])/i.test(part),
      )
  )
    throw new ServiceError(
      'unsafe_path',
      'Use a relative file path without control metadata or traversal',
      400,
    );
  return path;
}
export function validateTree(tree: WorkspaceTree): void {
  let bytes = 0;
  const names = Object.keys(tree);
  if (names.length > WORKSPACE_LIMITS.files)
    throw new ServiceError('workspace_limit', 'Workspace file limit exceeded');
  const folded = new Set<string>();
  const directories = new Set<string>();
  for (const path of names) {
    filePath(path);
    const key = path.toLocaleLowerCase('en-US');
    if (folded.has(key))
      throw new ServiceError('unsafe_path', 'Case-colliding paths are unsupported');
    folded.add(key);
    const item = tree[path]!;
    if (typeof item.content !== 'string' || typeof item.executable !== 'boolean')
      throw new ServiceError('invalid_file', 'Invalid workspace file');
    const data = Buffer.from(item.content, 'base64');
    if (data.toString('base64') !== item.content || data.length > WORKSPACE_LIMITS.fileBytes)
      throw new ServiceError('workspace_limit', 'Invalid or oversized workspace file');
    bytes += data.length;
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join('/'));
    for (let n = 1; n < parts.length; n++)
      if (Object.hasOwn(tree, parts.slice(0, n).join('/')))
        throw new ServiceError('unsafe_path', 'File/directory path conflict');
  }
  if (bytes > WORKSPACE_LIMITS.bytes)
    throw new ServiceError('workspace_limit', 'Workspace byte limit exceeded');
  if (names.length + directories.size > WORKSPACE_LIMITS.entries)
    throw new ServiceError('workspace_limit', 'Workspace entry limit exceeded');
}
/** Synchronous, nofollow reads. Commands never receive a writable mount of this tree. */
export function readTree(root: string, importing = false): WorkspaceTree {
  const tree: WorkspaceTree = Object.create(null);
  let entries = 0,
    bytes = 0,
    count = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 16) throw new ServiceError('workspace_limit', 'Workspace depth limit exceeded');
    const directory = opendirSync(dir),
      names: string[] = [];
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (++entries > WORKSPACE_LIMITS.entries)
          throw new ServiceError('workspace_limit', 'Workspace entry limit exceeded');
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    for (const name of names.sort()) {
      const full = join(dir, name),
        path = relative(root, full).split(sep).join('/');
      if (
        importing &&
        ([
          '.git',
          '.salaam',
          'node_modules',
          '.state',
          'dist',
          'coverage',
          '.env',
          'credentials',
        ].includes(name) ||
          name.startsWith('.env.'))
      )
        continue;
      filePath(path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink())
        throw new ServiceError('unsafe_path', 'Symlinks are unsupported in coding workspaces');
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1)
        throw new ServiceError('unsafe_path', 'Only regular files with one link are admitted');
      if (
        ++count > WORKSPACE_LIMITS.files ||
        stat.size > WORKSPACE_LIMITS.fileBytes ||
        (bytes += stat.size) > WORKSPACE_LIMITS.bytes
      )
        throw new ServiceError('workspace_limit', 'Workspace exceeds bounded import limits');
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        if (before.dev !== stat.dev || before.ino !== stat.ino || before.nlink !== 1)
          throw new ServiceError('workspace_changed', 'File changed during admission');
        if (before.size !== stat.size || before.size > WORKSPACE_LIMITS.fileBytes)
          throw new ServiceError('workspace_changed', 'File changed during admission');
        const buffer = Buffer.allocUnsafe(WORKSPACE_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
        const content = buffer.subarray(0, length);
        const after = fstatSync(fd);
        if (
          content.length !== before.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new ServiceError('workspace_changed', 'File changed during read');
        tree[path] = { content: content.toString('base64'), executable: !!(stat.mode & 0o111) };
      } finally {
        closeSync(fd);
      }
    }
  };
  walk(root, 0);
  validateTree(tree);
  return tree;
}

export class Workspaces {
  private locks = new Map<string, string>();
  readonly root?: string;
  constructor(
    readonly store: Store,
    readonly artifacts: Artifacts,
    root?: string,
  ) {
    if (root) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.root = realpathSync(root);
      if ((lstatSync(this.root).mode & 0o077) !== 0)
        throw new Error('Coding root must be private (mode 700)');
    }
  }
  find(session: string): Workspace | undefined {
    return this.store.db
      .prepare('SELECT * FROM workspaces WHERE session_id=?')
      .get(session) as unknown as Workspace | undefined;
  }
  get(session: string): Workspace {
    const row = this.find(session);
    if (
      !row ||
      !this.root ||
      dirname(row.root) !== this.root ||
      realpathSync(row.root) !== row.root
    )
      throw new ServiceError('workspace_unavailable', 'Owned coding workspace is unavailable');
    return row;
  }
  import(session: string, source: string): Workspace {
    const prior = this.find(session);
    if (prior) {
      if (prior.source !== realpathSync(source))
        throw new ServiceError('workspace_conflict', 'Session already owns another source');
      return this.get(session);
    }
    if (!this.root)
      throw new ServiceError(
        'coding_disabled',
        'Start the service with an explicit private --coding-root',
      );
    const origin = realpathSync(source),
      id = randomUUID(),
      root = join(this.root, id);
    if (origin === this.root || this.root.startsWith(origin + sep))
      throw new ServiceError('unsafe_path', 'Coding root cannot be inside the source');
    const tree = readTree(origin, true);
    mkdirSync(root, { mode: 0o700 });
    this.writeTree(root, {}, tree);
    const baseline = this.artifacts.prepare(session, JSON.stringify(tree));
    this.store.transaction(() => {
      baseline.commit();
      this.store.db
        .prepare("INSERT INTO workspaces VALUES (?,?,?,?,0,?,?,'ready')")
        .run(id, session, origin, root, digest(tree), baseline.id);
      this.store.event(session, 'workspace.created', {
        workspace_id: id,
        source: origin,
        revision: 0,
        digest: digest(tree),
      });
    });
    return this.get(session);
  }
  /** Publish a fresh, deterministic occurrence root; never overwrite a partial or edited root. */
  cloneSnapshot(session: string, tree: WorkspaceTree): Workspace {
    validateTree(tree);
    const prior = this.find(session);
    if (prior) {
      this.verify(session);
      return prior;
    }
    if (!this.root) throw new ServiceError('coding_disabled', 'No coding root');
    const root = join(this.root, session);
    if (!existsSync(root)) {
      const staging = join(this.root, session + '-staging-' + randomUUID());
      mkdirSync(staging, { mode: 0o700 });
      this.writeTree(staging, {}, tree);
      renameSync(staging, root);
      const fd = openSync(this.root, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    if (digest(readTree(root)) !== digest(tree))
      throw new ServiceError(
        'workspace_conflict',
        'Occurrence workspace changed before publication',
      );
    const baseline = this.artifacts.prepare(session, JSON.stringify(tree));
    const publish = () => {
      baseline.commit();
      this.store.db
        .prepare("INSERT INTO workspaces VALUES (?,?,?,?,0,?,?,'ready')")
        .run(session, session, root, root, digest(tree), baseline.id);
      this.store.event(session, 'workspace.created', {
        workspace_id: session,
        revision: 0,
        digest: digest(tree),
        cloned: true,
      });
    };
    if (this.store.db.isTransaction) publish();
    else this.store.transaction(publish);
    return this.get(session);
  }
  inspect(session: string): unknown {
    const w = this.get(session);
    let observed_digest: string | null = null;
    try {
      observed_digest = digest(readTree(w.root));
    } catch {}
    return {
      ...w,
      observed_digest,
      limits: WORKSPACE_LIMITS,
      locked_by: this.locks.get(w.id) ?? null,
    };
  }
  refresh(
    session: string,
    request: string,
    expected: number,
    reviewed: string,
    authorize: () => void,
  ): Workspace {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'workspace-refresh', session, expected, reviewed },
      () => {
        authorize();
        const w = this.get(session);
        if (w.revision >= WORKSPACE_LIMITS.revisions)
          throw new ServiceError('workspace_limit', 'Workspace revision/storage limit reached');
        if (this.locks.has(w.id))
          throw new ServiceError('workspace_busy', 'A command owns this workspace');
        if (w.revision !== expected || digest(readTree(w.root)) !== reviewed)
          throw new ServiceError('workspace_changed', 'Reviewed workspace state changed');
        if (
          this.store.db
            .prepare("SELECT 1 FROM workspace_mutations WHERE workspace_id=? AND state='prepared'")
            .get(w.id)
        )
          throw new ServiceError('workspace_conflict', 'Reconcile pending patches first');
        this.store.db
          .prepare("UPDATE workspaces SET revision=revision+1,digest=?,state='ready' WHERE id=?")
          .run(reviewed, w.id);
        this.store.event(session, 'workspace.refreshed', { workspace_id: w.id, digest: reviewed });
        return this.get(session);
      },
    );
  }
  lock(session: string, owner: string): Workspace {
    const w = this.verify(session, owner);
    const lock = this.locks.get(w.id);
    if (lock && lock !== owner)
      throw new ServiceError('workspace_busy', 'A command owns this workspace');
    this.locks.set(w.id, owner);
    return w;
  }
  hold(session: string, owner: string): void {
    const w = this.get(session),
      prior = this.locks.get(w.id);
    if (prior && prior !== owner)
      throw new ServiceError('workspace_busy', 'Another run owns the workspace');
    this.locks.set(w.id, owner);
  }
  unlock(session: string, owner: string): void {
    const w = this.find(session);
    if (w && this.locks.get(w.id) === owner) this.locks.delete(w.id);
  }
  verify(session: string, owner?: string): Workspace {
    const w = this.get(session);
    if (w.state !== 'ready')
      throw new ServiceError('workspace_conflict', 'Workspace requires explicit reconciliation');
    if (this.locks.has(w.id) && this.locks.get(w.id) !== owner)
      throw new ServiceError('workspace_busy', 'A command owns this workspace');
    if (digest(readTree(w.root)) !== w.digest)
      throw new ServiceError(
        'workspace_changed',
        'Out-of-band workspace edit detected; no overwrite was performed',
      );
    return w;
  }
  read(session: string, args: Record<string, unknown>): unknown {
    const w = this.verify(session),
      tree = readTree(w.root);
    if (digest(tree) !== w.digest)
      throw new ServiceError('workspace_changed', 'Workspace changed during read');
    const action = string(args.action, 'action', 16);
    if (action === 'inspect') return this.inspect(session);
    const offset = args.offset === undefined ? 0 : integer(args.offset, 'offset');
    if (action === 'list') {
      const all = Object.keys(tree).sort();
      return {
        workspace_id: w.id,
        revision: w.revision,
        digest: w.digest,
        files: all.slice(offset, offset + 20).map((path) => ({
          path,
          hash: digest(tree[path]),
          bytes: Buffer.from(tree[path]!.content, 'base64').length,
        })),
        next_offset: offset + 20 < all.length ? offset + 20 : null,
      };
    }
    if (action === 'read') {
      const path = filePath(args.path),
        file = tree[path];
      if (!file) throw new ServiceError('not_found', 'Workspace file not found', 404);
      const data = Buffer.from(file.content, 'base64'),
        text = data.toString('utf8');
      if (text.includes('\0') || !Buffer.from(text).equals(data))
        throw new ServiceError('binary_file', 'File is not UTF-8 text');
      const lines = text.split('\n'),
        page: { line: number; text: string }[] = [];
      let bytes = 0,
        next = offset;
      while (next < lines.length && page.length < 100) {
        const line = lines[next]!;
        if (Buffer.byteLength(line) > 4096)
          throw new ServiceError('line_limit', 'Line exceeds text-tool limit');
        if ((bytes += Buffer.byteLength(line)) > 8192) break;
        page.push({ line: next + 1, text: line });
        next++;
      }
      return {
        workspace_id: w.id,
        revision: w.revision,
        path,
        hash: digest(file),
        lines: page,
        next_offset: next < lines.length ? next : null,
      };
    }
    if (action === 'search') {
      const query = string(args.query, 'query', 256),
        matches: unknown[] = [];
      let index = 0,
        next: number | null = null;
      outer: for (const path of Object.keys(tree).sort()) {
        const text = Buffer.from(tree[path]!.content, 'base64').toString('utf8');
        if (text.includes('\0')) continue;
        const lines = text.split('\n');
        for (let line = 0; line < lines.length; line++)
          if (lines[line]!.includes(query)) {
            if (index++ < offset) continue;
            if (matches.length >= 10) {
              next = index - 1;
              break outer;
            }
            matches.push({ path, line: line + 1, text: lines[line]!.slice(0, 512) });
          }
      }
      return { revision: w.revision, matches, next_offset: next };
    }
    throw new ServiceError('invalid_field', 'Unsupported file action', 400);
  }
  patch(session: string, key: string, args: Record<string, unknown>): Mutation {
    const w = this.get(session),
      prior = this.mutation(w.id, key);
    const input = digest(args);
    if (prior) {
      if (prior.input_digest !== input)
        throw new ServiceError('request_conflict', 'Patch ID already binds different arguments');
      return prior;
    }
    this.store.execution.assert(session);
    this.verify(session);
    if (integer(args.expected_revision, 'expected_revision') !== w.revision)
      throw new ServiceError('workspace_changed', 'Workspace revision changed');
    const path = filePath(args.path),
      before = readTree(w.root),
      after: WorkspaceTree = Object.assign(Object.create(null), before);
    const expected = before[path] ? digest(before[path]) : null;
    if (args.expected_hash !== expected)
      throw new ServiceError('workspace_changed', 'File hash changed; reread before patching');
    if (args.content === null) {
      if (!before[path]) throw new ServiceError('not_found', 'File not found', 404);
      delete after[path];
    } else
      after[path] = {
        content: Buffer.from(
          typeof args.content === 'string' && args.content.length === 0
            ? ''
            : string(args.content, 'content', WORKSPACE_LIMITS.fileBytes),
        ).toString('base64'),
        executable: before[path]?.executable ?? false,
      };
    return this.replace(session, key, input, w.revision, before, after);
  }
  replace(
    session: string,
    key: string,
    input: string,
    revision: number,
    before: WorkspaceTree,
    after: WorkspaceTree,
    owner?: string,
  ): Mutation {
    const w = this.get(session),
      prior = this.mutation(w.id, key);
    if (prior) {
      if (prior.input_digest !== input)
        throw new ServiceError('request_conflict', 'Mutation arguments changed');
      return prior;
    }
    this.verify(session, owner);
    if (w.revision >= WORKSPACE_LIMITS.revisions)
      throw new ServiceError('workspace_limit', 'Workspace revision/storage limit reached');
    validateTree(after);
    if (w.revision !== revision || digest(before) !== w.digest)
      throw new ServiceError('workspace_changed', 'Workspace changed before apply');
    const artifact = this.artifacts.prepare(session, JSON.stringify(after)),
      id = randomUUID();
    const nextRoot = join(this.root!, w.id + '-revision-' + id);
    this.store.transaction(() => {
      artifact.commit();
      this.store.db
        .prepare("INSERT INTO workspace_mutations VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',NULL)")
        .run(
          id,
          w.id,
          key,
          input,
          revision,
          digest(before),
          digest(after),
          artifact.id,
          w.root,
          nextRoot,
        );
      this.store.recordTaskMutation?.(session, id, before, after);
      this.store.event(session, 'workspace.mutation_prepared', {
        mutation_id: id,
        revision,
        before_digest: digest(before),
        after_digest: digest(after),
      });
    });
    // An error/crash from this point is reconciled from file content, never replayed blindly.
    // Published roots are never rewritten by a patch. Concurrent editors retain their old bytes.
    mkdirSync(nextRoot, { mode: 0o700 });
    this.writeTree(nextRoot, {}, after);
    this.reconcile(id);
    return this.mutation(w.id, key)!;
  }
  private mutation(workspace: string, key: string): Mutation | undefined {
    return this.store.db
      .prepare('SELECT * FROM workspace_mutations WHERE workspace_id=? AND request_key=?')
      .get(workspace, key) as unknown as Mutation | undefined;
  }
  private writeTree(root: string, before: WorkspaceTree, after: WorkspaceTree): void {
    for (const path of Object.keys(after).sort()) {
      if (digest(after[path]) === digest(before[path] ?? null)) continue;
      const full = join(root, filePath(path));
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      const temp = full + '.' + randomUUID() + '.tmp',
        fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, Buffer.from(after[path]!.content, 'base64'));
        chmodSync(temp, after[path]!.executable ? 0o700 : 0o600);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, full);
      const parent = openSync(dirname(full), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    for (const path of Object.keys(before).sort())
      if (!after[path]) {
        unlinkSync(join(root, filePath(path)));
        let empty = dirname(join(root, path));
        while (empty !== root && readdirSync(empty).length === 0) {
          rmdirSync(empty);
          empty = dirname(empty);
        }
        const parent = openSync(empty, 'r');
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      }
    const sync = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) sync(join(dir, entry.name));
      const fd = openSync(dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    sync(root);
    const parent = openSync(dirname(root), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  reconcile(id: string): void {
    const op = this.store.db
      .prepare('SELECT * FROM workspace_mutations WHERE id=?')
      .get(id) as unknown as Mutation;
    const w = this.store.db
      .prepare('SELECT * FROM workspaces WHERE id=?')
      .get(op.workspace_id) as unknown as Workspace;
    let actual = '';
    try {
      actual = digest(readTree(op.after_root));
    } catch {}
    this.store.transaction(() => {
      let before = '';
      try {
        before = digest(readTree(op.before_root));
      } catch {}
      const prior =
        w.root === op.before_root &&
        before === op.before_digest &&
        w.revision === op.expected_revision;
      const success = actual === op.after_digest && prior;
      const unchanged = actual !== op.after_digest && prior;
      const state = success ? 'applied' : unchanged ? 'failed_definite' : 'conflict';
      this.store.db
        .prepare('UPDATE workspace_mutations SET state=?,error=? WHERE id=?')
        .run(state, success ? null : 'Interrupted or conflicting file application', id);
      if (success)
        this.store.db
          .prepare('UPDATE workspaces SET revision=revision+1,digest=?,root=? WHERE id=?')
          .run(actual, op.after_root, w.id);
      if (!success && !unchanged)
        this.store.db.prepare("UPDATE workspaces SET state='conflict' WHERE id=?").run(w.id);
      this.store.event(w.session_id, 'workspace.mutation_' + state, {
        mutation_id: id,
        workspace_id: w.id,
        digest: actual,
      });
    });
  }
  recover(): void {
    for (const row of this.store.db
      .prepare("SELECT id FROM workspace_mutations WHERE state='prepared'")
      .all())
      this.reconcile(String(row.id));
  }
  diff(session: string, offset = 0): unknown {
    const w = this.verify(session),
      baseline: WorkspaceTree = Object.assign(
        Object.create(null),
        JSON.parse(this.artifacts.read(w.baseline)),
      ),
      current = readTree(w.root);
    if (digest(current) !== w.digest)
      throw new ServiceError('workspace_changed', 'Workspace changed during diff capture');
    const changes = [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
      .sort()
      .filter((path) => digest(baseline[path] ?? null) !== digest(current[path] ?? null))
      .map((path) => ({ path, before: baseline[path] ?? null, after: current[path] ?? null }));
    return {
      workspace_id: w.id,
      revision: w.revision,
      digest: w.digest,
      source: w.source,
      changes: changes.slice(offset, offset + 1),
      next_offset: offset + 1 < changes.length ? offset + 1 : null,
      source_untouched: true,
    };
  }
}
