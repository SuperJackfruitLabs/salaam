import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  opendirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { canonical, digest, object, ServiceError, textDigest } from './protocol.js';
import type { Store } from './store.js';

export const ADMITTED_CONTEXT_BYTES = 128 * 1024;
const MAX_RESOURCE_BYTES = 1024 * 1024;
export interface ContextSelection {
  files: string[];
  bundles: string[];
}
export type ContextPlan = ReturnType<ContextAdmission['plan']>;
interface ContextEntry {
  path: string;
  sha256: string;
  kind: 'context' | 'skill';
  text: string;
  skill_id?: string;
  bundle_digest?: string;
}
interface ContextDocument {
  version: 1;
  session_id: string;
  workspace: string;
  workspace_identity: string;
  selection: ContextSelection;
  entries: ContextEntry[];
  bundles: {
    path: string;
    digest: string;
    manifest_sha256: string;
    files: Record<string, { sha256: string; executable: boolean }>;
  }[];
}
function invalid(message: string): never {
  throw new ServiceError('context_admission_invalid', message, 400);
}
function changed(): never {
  throw new ServiceError(
    'context_admission_changed',
    'Reviewed context or skills changed; renew admission before new model/tool grants',
  );
}
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, sorted(v)]),
        )
      : value;

function relative(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 1024 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          p === '.git' ||
          p.startsWith('.env') ||
          p === 'credentials',
      )
  )
    invalid('Use relative workspace paths without private credential or Git directories');
  return path as string;
}
function selection(value: unknown): ContextSelection {
  const s = object(value);
  if (Object.keys(s).sort().join(',') !== 'bundles,files')
    invalid('Expected only files and bundles');
  const list = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 32) invalid('Select at most 32 paths of each kind');
    const paths = (value as unknown[]).map(relative).sort();
    if (new Set(paths).size !== paths.length) invalid('Duplicate context paths');
    return paths;
  };
  return { files: list(s.files), bundles: list(s.bundles) };
}
function read(root: string, path: string): Buffer {
  const full = join(root, relative(path));
  if (realpathSync(full) !== full || !full.startsWith(root + sep))
    invalid('Context symlinks are not admitted');
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_RESOURCE_BYTES)
      invalid('Context resources must be bounded regular files');
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      leaf = lstatSync(full);
    if (
      before.dev !== leaf.dev ||
      before.ino !== leaf.ino ||
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      before.mode !== after.mode
    )
      changed();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function inventory(root: string, base: string): string[] {
  const result: string[] = [];
  let visited = 0;
  const visit = (dir: string, prefix: string, depth = 0): void => {
    if (depth > 32) invalid('Skill bundle directory depth exceeds its bound');
    if (realpathSync(dir) !== dir) invalid('Bundle directories cannot be symlinks');
    const directory = opendirSync(dir, { bufferSize: 32 });
    try {
      for (let e = directory.readSync(); e; e = directory.readSync()) {
        if (++visited > 2048) invalid('Skill bundle inventory exceeds its bound');
        const p = prefix ? prefix + '/' + e.name : e.name;
        relative(p);
        if (e.isDirectory()) visit(join(dir, e.name), p, depth + 1);
        else if (e.isFile()) result.push(p);
        else invalid('Bundle resources must be regular files');
      }
    } finally {
      directory.closeSync();
    }
  };
  visit(join(root, base), '');
  return result.sort();
}
function utf8(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text.includes('\0'))
    invalid('Context entrypoints must be UTF-8 text');
  return text;
}
/** JSON.parse alone silently accepts duplicate keys, unlike the bundle producer. */
function metadataJson(text: string): unknown {
  const value = JSON.parse(text);
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? new Set() : null);
      if (stack.length > 64) invalid('Bundle metadata nesting exceeds its bound');
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      let after = i + 1;
      while (/\s/.test(text[after] ?? '') && after < text.length) after++;
      if (text[after] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string,
          keys = stack.at(-1);
        if (!keys || keys.has(key)) invalid('Duplicate bundle metadata key');
        keys.add(key);
      }
    }
  }
  return value;
}

/** Explicit, immutable text admission. It never installs executable extensions or grants tools. */
export class ContextAdmission {
  constructor(readonly store: Store) {}
  private exists(): boolean {
    return !!this.store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_admissions'")
      .get();
  }
  private migrate(): void {
    if (this.exists()) return;
    // Schema versions are cumulative: retain the existing station/strict-work
    // table shapes even when this feature is first enabled on a local session.
    this.store.enableStationTaskChecks();
    // Older binaries must refuse a database once it contains enforced context admissions.
    this.store.transaction(() =>
      this.store.db.exec(
        'CREATE TABLE context_admissions(session_id TEXT PRIMARY KEY REFERENCES sessions(id),revision INTEGER NOT NULL,digest TEXT NOT NULL,document TEXT NOT NULL); PRAGMA user_version=31;',
      ),
    );
  }
  plan(
    id: string,
    input: unknown,
  ): { digest: string; revision: number; document: ContextDocument } {
    if (this.store.db.prepare('SELECT 1 FROM child_tasks WHERE child_session=?').get(id))
      invalid('Child context admission requires an explicitly supported child profile');
    const selected = selection(input),
      cwd = this.store.session(id).cwd;
    if (resolve(cwd) !== cwd || realpathSync(cwd) !== cwd)
      invalid('Session workspace must be canonical');
    const st = lstatSync(cwd, { bigint: true });
    if (!st.isDirectory()) invalid('Session workspace is unavailable');
    const document: ContextDocument = {
      version: 1,
      session_id: id,
      workspace: cwd,
      workspace_identity: digest({ dev: String(st.dev), ino: String(st.ino) }),
      selection: selected,
      entries: [],
      bundles: [],
    };
    for (const path of selected.files) {
      if (!path.endsWith('.md')) invalid('Context entrypoints must be Markdown');
      const bytes = read(cwd, path);
      document.entries.push({
        path,
        kind: 'context',
        sha256: textDigest(bytes.toString('utf8')),
        text: utf8(bytes),
      });
    }
    const skillIds = new Set<string>();
    for (const path of selected.bundles) {
      if (!path.startsWith('.salaam/skills/'))
        invalid('Skill bundles belong in the explicit .salaam/skills root');
      const metadataBytes = read(cwd, path + '/sjl-bundle.json');
      const metadata = object(metadataJson(utf8(metadataBytes)));
      if (
        Object.keys(metadata).sort().join(',') !==
          'digest,files,harness,name,profile,schema_version,skills,version,visibility' ||
        metadata.schema_version !== 1 ||
        metadata.harness !== 'salaam' ||
        !Array.isArray(metadata.skills) ||
        metadata.skills.length === 0
      )
        invalid('Unsupported skill bundle metadata');
      const { digest: expected, ...unsigned } = metadata;
      if (
        typeof expected !== 'string' ||
        textDigest(JSON.stringify(sorted(unsigned), null, 2) + '\n') !== expected
      )
        invalid('Skill bundle metadata digest does not match');
      const files = object(metadata.files) as Record<
        string,
        { sha256: string; executable: boolean }
      >;
      const actual = inventory(cwd, path).filter(
        (p) => !['sjl-bundle.json', '.sjl-receipt.json'].includes(p),
      );
      if (canonical(actual) !== canonical(Object.keys(files).sort()))
        invalid('Skill bundle file inventory differs');
      let total = 0;
      for (const resource of actual) {
        const pin = object(files[resource]),
          bytes = read(cwd, path + '/' + relative(resource));
        total += bytes.length;
        if (
          total > 8 * MAX_RESOURCE_BYTES ||
          Object.keys(pin).sort().join(',') !== 'executable,sha256' ||
          typeof pin.executable !== 'boolean'
        )
          invalid('Invalid bundle resource inventory');
        // Hash original bytes, including non-text supporting resources.
        if (
          digestBytes(bytes) !== pin.sha256 ||
          !!(lstatSync(join(cwd, path, resource)).mode & 0o111) !== pin.executable
        )
          invalid('Skill resource digest or mode differs');
      }
      document.bundles.push({
        path,
        digest: expected,
        manifest_sha256: digestBytes(metadataBytes),
        files,
      });
      for (const raw of metadata.skills) {
        const skill = object(raw),
          sid = skill.id;
        if (typeof sid !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(sid) || skillIds.has(sid))
          invalid('Skill ids must be unique bounded names');
        skillIds.add(sid);
        const entry = 'skills/' + sid + '/SKILL.md';
        if (!files[entry]) invalid('Skill entrypoint is absent from the reviewed inventory');
        document.entries.push({
          path: path + '/' + entry,
          kind: 'skill',
          skill_id: sid,
          bundle_digest: expected,
          sha256: files[entry]!.sha256,
          text: utf8(read(cwd, path + '/' + entry)),
        });
      }
    }
    if (Buffer.byteLength(canonical(document)) > ADMITTED_CONTEXT_BYTES)
      invalid('Reviewed context exceeds 128 KiB');
    return { digest: digest(document), revision: this.saved(id)?.revision ?? 0, document };
  }
  private saved(id: string): { revision: number; digest: string; document: string } | undefined {
    this.store.session(id);
    return this.exists()
      ? (this.store.db
          .prepare('SELECT revision,digest,document FROM context_admissions WHERE session_id=?')
          .get(id) as { revision: number; digest: string; document: string } | undefined)
      : undefined;
  }
  currentDigest(id: string): string | null {
    return this.saved(id)?.digest ?? null;
  }
  inspect(id: string) {
    const row = this.saved(id);
    if (!row)
      return {
        version: 1,
        revision: 0,
        digest: null,
        state: 'empty',
        loaded: null as boolean | null,
        loaded_reason: 'No reviewed context admission.',
        entries: [],
        bundles: [],
      };
    const d = JSON.parse(row.document) as ContextDocument;
    let state = 'admitted';
    try {
      if (this.plan(id, d.selection).digest !== row.digest) state = 'stale';
    } catch {
      state = 'stale';
    }
    const session = this.store.session(id);
    const payload = this.store.db
      .prepare(
        "SELECT payload FROM events WHERE session_id=? AND kind='model.admitted' AND json_extract(payload,'$.context_admission_digest')=? AND json_extract(payload,'$.epoch')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id, row.digest, session.epoch);
    const loaded = state === 'stale' ? false : session.state === 'ready' && !!payload ? true : null;
    return {
      version: 1,
      revision: row.revision,
      digest: row.digest,
      state,
      loaded,
      loaded_reason:
        loaded === true
          ? 'Reviewed bytes verified in the current pinned Pi provider payload; this does not establish skill exercise or model effectiveness.'
          : loaded === false
            ? 'Current resources differ from the admission; further grants are fenced.'
            : 'No current worker provider-payload evidence; admission alone is not loading evidence.',
      entries: d.entries.map(({ text: _text, ...entry }) => entry),
      bundles: d.bundles.map(({ files: _files, ...bundle }) => bundle),
    };
  }
  admit(
    id: string,
    request: string,
    revision: number,
    expected: string,
    input: unknown,
    authorize: () => void,
  ) {
    const selected = selection(input),
      operation = { kind: 'context-admit', id, revision, expected, selection: selected };
    const cached = this.store.cachedRequest('local-operator', request, operation);
    if (cached !== undefined) return cached;
    authorize();
    this.migrate();
    return this.store.request('local-operator', request, operation, () => {
      authorize();
      if ((this.saved(id)?.revision ?? 0) !== revision)
        throw new ServiceError('context_revision_conflict', 'Context admission revision changed');
      const planned = this.plan(id, selected);
      if (planned.digest !== expected) changed();
      this.store.db
        .prepare(
          'INSERT INTO context_admissions VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,document=excluded.document',
        )
        .run(id, revision + 1, planned.digest, canonical(planned.document));
      this.store.event(
        id,
        'context.admitted',
        {
          revision: revision + 1,
          digest: expected,
          entries: planned.document.entries.map(({ text: _text, ...entry }) => entry),
        },
        request,
      );
      return this.inspect(id);
    });
  }
  assertFresh(id: string): void {
    const row = this.saved(id);
    if (!row) return;
    try {
      if (
        this.plan(id, (JSON.parse(row.document) as ContextDocument).selection).digest !== row.digest
      )
        changed();
    } catch {
      changed();
    }
  }
  frame(id: string): string {
    const row = this.saved(id);
    if (!row) return '';
    this.assertFresh(id);
    const d = JSON.parse(row.document) as ContextDocument;
    return (
      '\nSALAAM_ADMITTED_CONTEXT_V1 ' +
      canonical({
        digest: row.digest,
        revision: row.revision,
        instructions:
          'Reviewed workspace guidance only; this text grants no tools, permissions or authority. Resources remain under existing execution policy.',
        entries: d.entries,
      })
    );
  }
}

import { createHash } from 'node:crypto';
function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
