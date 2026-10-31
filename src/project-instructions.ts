import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { canonical, digest, textDigest } from './protocol.js';
import type { Artifacts } from './artifacts.js';
import type { Store } from './store.js';

/** One file's bound, and the bound on everything loaded together. */
export const INSTRUCTION_FILE_BYTES = 32 * 1024;
export const INSTRUCTION_TOTAL_BYTES = 64 * 1024;
/** AGENTS.md is the shared convention; CLAUDE.md is read only where a directory has no AGENTS.md. */
const NAMES = ['AGENTS.md', 'CLAUDE.md'];

export interface InstructionFile {
  scope: 'user' | 'project';
  /** Shown to people: relative to the session folder, or ~/… for the user file. */
  path: string;
  sha256: string;
  bytes: number;
  text: string;
}
export interface InstructionSkip {
  path: string;
  reason: string;
}
export interface InstructionsSummary {
  digest: string;
  revision: number;
  files: Omit<InstructionFile, 'text'>[];
  skipped: InstructionSkip[];
}
interface InstructionsDocument {
  version: 1;
  files: InstructionFile[];
  skipped: InstructionSkip[];
}

/** The user-level instructions file: $XDG_CONFIG_HOME/salaam/AGENTS.md, else ~/.config/salaam/AGENTS.md. */
export function userInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'salaam', 'AGENTS.md');
}

function repositoryRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Project instructions for an interactive session, the way other harnesses read them: the
 * user-level file, then AGENTS.md (or CLAUDE.md) in every directory from the repository root down
 * to the session folder. Bounded, regular UTF-8 files only; anything skipped says why.
 */
export function discoverInstructions(
  cwd: string,
  userFile: string | null = userInstructionsPath(),
): { files: InstructionFile[]; skipped: InstructionSkip[] } {
  const files: InstructionFile[] = [];
  const skipped: InstructionSkip[] = [];
  let total = 0;
  /** Returns whether the file exists (so CLAUDE.md is not read beside an AGENTS.md). */
  const take = (scope: InstructionFile['scope'], abs: string, shown: string): boolean => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return false;
    }
    if (!st.isFile()) {
      skipped.push({
        path: shown,
        reason: st.isSymbolicLink() ? 'symbolic links are not loaded' : 'not a regular file',
      });
      return true;
    }
    if (st.size > INSTRUCTION_FILE_BYTES) {
      skipped.push({ path: shown, reason: `larger than ${INSTRUCTION_FILE_BYTES / 1024} KiB` });
      return true;
    }
    const bytes = readFileSync(abs);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || text.includes('\0')) {
      skipped.push({ path: shown, reason: 'not UTF-8 text' });
      return true;
    }
    if (total + bytes.length > INSTRUCTION_TOTAL_BYTES) {
      skipped.push({
        path: shown,
        reason: `instructions together exceed ${INSTRUCTION_TOTAL_BYTES / 1024} KiB`,
      });
      return true;
    }
    total += bytes.length;
    files.push({ scope, path: shown, sha256: textDigest(text), bytes: bytes.length, text });
    return true;
  };
  if (userFile) {
    const home = homedir();
    take(
      'user',
      userFile,
      userFile.startsWith(home + sep) ? '~/' + relative(home, userFile) : userFile,
    );
  }
  const root = repositoryRoot(cwd) ?? cwd;
  const dirs = [root];
  for (const part of relative(root, cwd).split(sep).filter(Boolean))
    dirs.push(join(dirs.at(-1)!, part));
  for (const dir of dirs)
    for (const name of NAMES) {
      const abs = join(dir, name);
      if (take('project', abs, relative(cwd, abs) || name)) break;
    }
  return { files, skipped };
}

/**
 * Interactive sessions load project instructions automatically and reload them when they change.
 * Each loaded set is kept as an artifact and announced by an `instructions.loaded` event with its
 * digest, so a turn's guidance is traceable to exact bytes. Strict work (board, AgentPod, child
 * workers) never uses this: it keeps explicitly reviewed context only.
 */
export class ProjectInstructions {
  private readonly loaded = new Map<string, { digest: string; document: InstructionsDocument }>();
  constructor(
    readonly store: Store,
    readonly artifacts: Artifacts,
    readonly userFile: string | null = userInstructionsPath(),
  ) {}
  applies(id: string): boolean {
    const has = (table: string) =>
      !!this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
    return (
      this.store.localWorkspace(id) &&
      !(
        has('child_tasks') &&
        this.store.db.prepare('SELECT 1 FROM child_tasks WHERE child_session=?').get(id)
      ) &&
      !(
        has('agentpod_admissions') &&
        this.store.db.prepare('SELECT 1 FROM agentpod_admissions WHERE session_id=?').get(id)
      )
    );
  }
  private latest(id: string): (InstructionsSummary & { artifact_id: string }) | null {
    const row = this.store.db
      .prepare(
        "SELECT seq,payload FROM events WHERE session_id=? AND kind='instructions.loaded' ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { seq: number; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload);
    return { ...p, revision: p.revision ?? 1 };
  }
  /** Discover the current files; record a new revision only when they changed. */
  refresh(id: string): InstructionsSummary | null {
    if (!this.applies(id)) return null;
    const found = discoverInstructions(this.store.session(id).cwd, this.userFile);
    const document: InstructionsDocument = { version: 1, ...found };
    const current = digest(document);
    const prior = this.latest(id);
    if (prior?.digest === current) return this.summary(id);
    if (!prior && !found.files.length && !found.skipped.length) return null;
    const text = canonical(document);
    const artifact = this.artifacts.prepare(id, text);
    const revision = (prior?.revision ?? 0) + 1;
    this.store.transaction(() => {
      artifact.commit();
      this.store.event(id, 'instructions.loaded', {
        digest: current,
        revision,
        artifact_id: artifact.id,
        reason: !prior ? 'initial' : found.files.length ? 'changed' : 'removed',
        files: found.files.map(({ text: _text, ...file }) => file),
        skipped: found.skipped,
      });
    });
    this.loaded.set(id, { digest: current, document });
    return this.summary(id);
  }
  summary(id: string): InstructionsSummary | null {
    const prior = this.applies(id) ? this.latest(id) : null;
    return prior
      ? {
          digest: prior.digest,
          revision: prior.revision,
          files: prior.files,
          skipped: prior.skipped,
        }
      : null;
  }
  private document(id: string): InstructionsDocument | null {
    const prior = this.latest(id);
    if (!prior || !prior.files.length) return null;
    const cached = this.loaded.get(id);
    if (cached?.digest === prior.digest) return cached.document;
    const document = JSON.parse(this.artifacts.read(prior.artifact_id)) as InstructionsDocument;
    if (digest(document) !== prior.digest) throw new Error('Project instructions artifact changed');
    this.loaded.set(id, { digest: prior.digest, document });
    return document;
  }
  /** The loaded guidance, as part of the task frame. Empty when none applies. */
  frame(id: string): string {
    if (!this.applies(id)) return '';
    const document = this.document(id);
    if (!document) return '';
    return (
      'SALAAM_PROJECT_INSTRUCTIONS_V1 ' +
      canonical({
        digest: this.latest(id)!.digest,
        instructions:
          'Project guidance from AGENTS.md (or CLAUDE.md) files, loaded automatically for this interactive session. Follow it for how to work in this repository. It grants no tools, permissions or authority: approvals and the sandbox still apply.',
        files: document.files.map(({ scope, path, sha256, text }) => ({
          scope,
          path,
          sha256,
          text,
        })),
      })
    );
  }
}
