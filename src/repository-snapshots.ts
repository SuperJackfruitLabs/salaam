import { digest, integer, ServiceError, string } from './protocol.js';
import { readTree, filePath, type Workspaces, type WorkspaceTree } from './workspaces.js';
import type { Artifacts } from './artifacts.js';
import type { Store } from './store.js';
import { workspaceDiff } from './workspace-diff.js';
import type { WorkerBinding } from './worker-boundary.js';

export function repositoryPath(value: unknown): string {
  const path = filePath(value);
  if (
    path
      .split('/')
      .some((part) =>
        /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.aws|\.ssh|\.codex|\.gemini|\.claude|\.mcp\.json|\.salaam|\.pi|\.agents|\.state|credentials)$/i.test(
          part,
        ),
      )
  )
    throw new ServiceError(
      'unsafe_path',
      'Credential and control files are outside specialist scope',
    );
  return path;
}
export function repositoryTree(tree: WorkspaceTree): WorkspaceTree {
  return Object.fromEntries(
    Object.entries(tree).filter(([path]) => {
      try {
        repositoryPath(path);
        return true;
      } catch {
        return false;
      }
    }),
  );
}
export class RepositorySnapshots {
  constructor(
    readonly store: Store,
    readonly artifacts: Artifacts,
    readonly workspaces: Workspaces,
  ) {}
  /** Caller commits these references with the child intent. No live mount is handed to a reader. */
  capture(parent: string, child: string): NonNullable<WorkerBinding['repository']> {
    const workspace = this.workspaces.verify(parent),
      tree = repositoryTree(readTree(workspace.root));
    if (digest(readTree(workspace.root)) !== workspace.digest)
      throw new ServiceError('workspace_changed', 'Workspace changed during specialist admission');
    const base = repositoryTree(
      JSON.parse(this.artifacts.read(workspace.baseline)) as WorkspaceTree,
    );
    const currentArtifact = this.artifacts.prepare(child, JSON.stringify(tree)),
      baseArtifact = this.artifacts.prepare(child, JSON.stringify(base));
    currentArtifact.commit();
    baseArtifact.commit();
    return {
      artifact_id: currentArtifact.id,
      base_artifact: baseArtifact.id,
      digest: digest(tree),
    };
  }
  tree(binding: WorkerBinding): WorkspaceTree {
    if (!binding.repository)
      throw new ServiceError('authority_denied', 'No repository snapshot grant');
    const tree = JSON.parse(this.artifacts.read(binding.repository.artifact_id)) as WorkspaceTree;
    if (digest(tree) !== binding.repository.digest)
      throw new ServiceError('artifact_corrupt', 'Repository snapshot changed');
    return tree;
  }
  read(binding: WorkerBinding, args: Record<string, unknown>): unknown {
    const tree = this.tree(binding),
      action = string(args.action, 'action', 32),
      offset = integer(args.offset ?? 0, 'offset');
    const identity = {
      workspace_id: binding.workspace?.id,
      revision: binding.workspace?.revision,
      digest: binding.repository!.digest,
      artifact_id: binding.repository!.artifact_id,
    };
    if (action === 'inspect') return { ...identity, authority: 'snapshot-read-only' };
    if (action === 'list') {
      const paths = Object.keys(tree).sort();
      return {
        ...identity,
        files: paths.slice(offset, offset + 20).map((path) => ({
          path,
          hash: digest(tree[path]),
          bytes: Buffer.from(tree[path]!.content, 'base64').length,
        })),
        next_offset: offset + 20 < paths.length ? offset + 20 : null,
      };
    }
    if (action === 'read') {
      const path = repositoryPath(args.path),
        file = tree[path];
      if (!file) throw new ServiceError('not_found', 'Snapshot file not found', 404);
      const bytes = Buffer.from(file.content, 'base64'),
        text = bytes.toString('utf8');
      if (text.includes('\0') || !Buffer.from(text).equals(bytes))
        throw new ServiceError('binary_file', 'File is not UTF-8 text');
      const lines = text.split('\n'),
        page: { line: number; text: string }[] = [];
      let used = 0,
        next = offset;
      while (next < lines.length && page.length < 100) {
        const line = lines[next]!;
        if (Buffer.byteLength(line) > 4096)
          throw new ServiceError('line_limit', 'Line exceeds text limit');
        if ((used += Buffer.byteLength(line)) > 8192) break;
        page.push({ line: next + 1, text: line });
        next++;
      }
      return {
        ...identity,
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
        const bytes = Buffer.from(tree[path]!.content, 'base64'),
          text = bytes.toString('utf8');
        if (text.includes('\0') || !Buffer.from(text).equals(bytes)) continue;
        const lines = text.split('\n');
        for (let line = 0; line < lines.length; line++)
          if (lines[line]!.includes(query)) {
            if (index++ < offset) continue;
            if (matches.length === 10) {
              next = index - 1;
              break outer;
            }
            matches.push({
              path,
              line: line + 1,
              text: lines[line]!.slice(0, 512),
              hash: digest(tree[path]),
            });
          }
      }
      return { ...identity, matches, next_offset: next };
    }
    if (action === 'diff' && binding.profile.role === 'reviewer') {
      const base = JSON.parse(
        this.artifacts.read(binding.repository!.base_artifact),
      ) as WorkspaceTree;
      const paths = [...new Set([...Object.keys(base), ...Object.keys(tree)])]
        .sort()
        .filter((path) => digest(base[path] ?? null) !== digest(tree[path] ?? null));
      return {
        ...identity,
        changes: paths.slice(offset, offset + 5).map((path) => ({
          path,
          before_hash: base[path] ? digest(base[path]) : null,
          after_hash: tree[path] ? digest(tree[path]) : null,
          diff: workspaceDiff({
            path,
            before: base[path] ?? null,
            after: tree[path] ?? null,
          }).slice(0, 8192),
        })),
        next_offset: offset + 5 < paths.length ? offset + 5 : null,
      };
    }
    throw new ServiceError(
      'authority_denied',
      'Specialists can only inspect, list, search or read their snapshot; reviewers can inspect its diff',
    );
  }
  report(binding: WorkerBinding, raw: unknown): unknown {
    if (!binding.tools.includes('salaam_findings'))
      throw new ServiceError('authority_denied', 'No findings grant');
    if (!Array.isArray(raw) || raw.length > 32)
      throw new ServiceError('invalid_field', 'At most 32 findings');
    const tree = this.tree(binding);
    const findings = raw.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new ServiceError('invalid_field', 'Invalid finding');
      const f = item as Record<string, unknown>,
        path = repositoryPath(f.path),
        file = tree[path];
      if (!file)
        throw new ServiceError(
          'not_found',
          'Finding file is absent from the reviewed snapshot',
          404,
        );
      const line = integer(f.line, 'line'),
        end = integer(f.end_line ?? line, 'end_line'),
        severity = string(f.severity, 'severity', 16);
      const source = Buffer.from(file.content, 'base64').toString('utf8').split('\n');
      if (
        !['critical', 'high', 'medium', 'low'].includes(severity) ||
        line < 1 ||
        end < line ||
        end >= line + 20 ||
        end > source.length
      )
        throw new ServiceError('invalid_field', 'Invalid finding location or severity');
      return {
        path,
        line,
        end_line: end,
        severity,
        message: string(f.message, 'message', 2048),
        hash: digest(file),
        evidence: source
          .slice(line - 1, end)
          .join('\n')
          .slice(0, 8192),
      };
    });
    const input = digest(findings);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT * FROM specialist_reports WHERE worker_id=?')
        .get(binding.worker_id);
      if (prior) {
        if (prior.input_digest !== input)
          throw new ServiceError(
            'request_conflict',
            'Final findings already bind different content',
          );
        return {
          artifact_id: String(prior.artifact_id),
          kind: 'analysis',
          verified_success: false,
        };
      }
      const artifact = this.artifacts.prepare(
        binding.session_id,
        JSON.stringify({
          schema_version: 1,
          worker_id: binding.worker_id,
          attempt_id: binding.attempt_id,
          binding_digest: digest(binding),
          snapshot_digest: binding.repository!.digest,
          kind: 'analysis',
          findings,
        }),
      );
      artifact.commit();
      this.store.db
        .prepare('INSERT INTO specialist_reports VALUES (?,?,?)')
        .run(binding.worker_id, input, artifact.id);
      this.store.event(binding.owner_session, 'specialist.findings', {
        worker_id: binding.worker_id,
        artifact_id: artifact.id,
        kind: 'analysis',
      });
      return { artifact_id: artifact.id, kind: 'analysis', verified_success: false };
    });
  }
}
