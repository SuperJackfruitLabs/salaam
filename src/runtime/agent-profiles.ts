import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  lstatSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonical,
  digest,
  integer,
  object,
  ServiceError,
  string,
  textDigest,
  type Controller,
  DIAGNOSTIC_PROFILE,
  type AgentGrant,
  type AgentGrantSnapshot,
  type AgentProfile,
} from '../core/index.js';
import { providerRoute } from '../providers/index.js';
import type { ProviderRoute } from '../core/index.js';
import type { Store } from '../store/index.js';

const ROLE_TOOLS = {
  explorer: ['salaam_probe', 'salaam_repository'],
  reviewer: ['salaam_probe', 'salaam_repository', 'salaam_findings'],
  builder: ['salaam_probe', 'salaam_repository', 'salaam_files', 'salaam_command'],
  tester: ['salaam_probe', 'salaam_repository', 'salaam_command', 'salaam_findings'],
  integrator: ['salaam_probe', 'salaam_repository', 'salaam_findings'],
} as const;
export function profileTools(role: keyof typeof ROLE_TOOLS): string[] {
  return [...ROLE_TOOLS[role]].sort();
}
export const BUILTIN_PROFILES: AgentProfile[] = [
  DIAGNOSTIC_PROFILE,
  ...(['explorer', 'reviewer', 'builder', 'tester', 'integrator'] as const).map((role) => ({
    schema_version: 1 as const,
    id: 'salaam/' + role,
    revision: 1,
    role,
    tools: profileTools(role),
    max_depth: 1,
    max_requests: 8,
    description:
      role === 'explorer'
        ? 'Bounded evidence from an immutable repository snapshot'
        : role === 'reviewer'
          ? 'Independent findings over an immutable repository diff'
          : role === 'builder'
            ? 'Implement a proposal in a private owned workspace'
            : role === 'tester'
              ? 'Run bounded checks in an isolated disposable copy'
              : 'Review integration evidence without applying changes',
    prompt:
      role === 'explorer'
        ? 'Investigate only the supplied repository snapshot. Cite actual file paths, line numbers and hashes. Do not claim edits or execution.'
        : role === 'builder'
          ? 'Implement only the assigned change in your private owned workspace using salaam_files. Run bounded checks through salaam_command. Command edits are disposable. Do not claim the root workspace was changed or verified; return a proposal for explicit integration.'
          : role === 'tester'
            ? 'Inspect the admitted snapshot and run bounded checks using salaam_command. You cannot edit persistent files. Report actual outcomes; a model answer is not a root verification receipt.'
            : 'Review only the supplied immutable diff and repository snapshot. Report concrete findings with file/line evidence through salaam_findings. A finding is analysis, not a verification receipt.',
  })),
];

/** JSON front matter is a deliberately bounded subset, not an executable config format. */
export function parseAgentProfile(name: string, source: string): AgentProfile {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || Buffer.byteLength(source) > 49152)
    throw new ServiceError('invalid_profile', 'Invalid profile name or size');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new ServiceError('invalid_profile', 'Use JSON front matter between --- lines');
  let metadata: Record<string, unknown>;
  try {
    metadata = object(JSON.parse(match[1]!));
  } catch {
    throw new ServiceError('invalid_profile', 'Invalid JSON profile metadata');
  }
  const allowed = [
    'description',
    'revision',
    'role',
    'tools',
    'provider',
    'model',
    'max_requests',
    'max_depth',
  ];
  if (Object.keys(metadata).some((key) => !allowed.includes(key)))
    throw new ServiceError(
      'invalid_profile',
      'Profiles cannot define executables, credentials, plugins, environment or additional fields',
    );
  const role = string(metadata.role, 'role', 32) as keyof typeof ROLE_TOOLS;
  if (!Object.hasOwn(ROLE_TOOLS, role))
    throw new ServiceError('invalid_profile', 'Unsupported specialist role');
  const tools =
    metadata.tools === undefined
      ? profileTools(role)
      : [
          ...new Set(
            (Array.isArray(metadata.tools) ? metadata.tools : []).map((x) =>
              string(x, 'tool', 128),
            ),
          ),
        ].sort();
  if (!tools.length || tools.some((x) => !profileTools(role).includes(x)))
    throw new ServiceError('invalid_profile', 'Tools exceed the specialist role');
  const revision = integer(metadata.revision ?? 1, 'revision');
  const maxRequests = integer(metadata.max_requests ?? 8, 'max_requests');
  if (revision < 1 || maxRequests < 1 || maxRequests > 8 || (metadata.max_depth ?? 1) !== 1)
    throw new ServiceError(
      'invalid_profile',
      'Invalid revision, request limit or delegation depth',
    );
  if ((metadata.provider === undefined) !== (metadata.model === undefined))
    throw new ServiceError('invalid_profile', 'Select both provider and model');
  const prompt = string(match[2]!.trim(), 'prompt', 32768);
  return {
    schema_version: 1,
    id: 'project/' + name,
    revision,
    role,
    tools,
    max_depth: 1,
    description: string(metadata.description ?? name, 'description', 512),
    prompt,
    max_requests: maxRequests,
    source_digest: textDigest(source),
    ...(metadata.provider
      ? {
          provider: string(metadata.provider, 'provider', 128),
          model: string(metadata.model, 'model', 256),
        }
      : {}),
  };
}

export class AgentProfiles {
  assertExecution?: () => void;
  validateFrame?: (session: string) => void;
  constructor(
    readonly store: Store,
    private route: ProviderRoute,
    private prepareRoute: (
      route: ProviderRoute,
      session: string,
    ) => Promise<{ route: ProviderRoute; output_cap: boolean }>,
  ) {}
  list(session: string): AgentProfile[] {
    const root = this.store.session(session).cwd;
    const control = join(root, '.salaam'),
      directory = join(control, 'agents');
    for (const path of [control, directory]) {
      if (!existsSync(path)) return structuredClone(BUILTIN_PROFILES);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ServiceError('invalid_profile', 'Profile directories must not be symlinks');
    }
    const names = readdirSync(directory)
      .filter((name) => name.endsWith('.md'))
      .sort();
    if (names.length > 32) throw new ServiceError('invalid_profile', 'At most 32 project profiles');
    const profiles = names.map((file) => {
      const path = join(directory, file),
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 49152)
          throw new ServiceError('invalid_profile', 'Profile must be a bounded regular file');
        return parseAgentProfile(file.slice(0, -3), readFileSync(fd, 'utf8'));
      } finally {
        closeSync(fd);
      }
    });
    return [...structuredClone(BUILTIN_PROFILES), ...profiles];
  }
  inspect(session: string, id: string): AgentProfile {
    this.store.session(session);
    const builtin = BUILTIN_PROFILES.find((profile) => profile.id === id);
    if (builtin) return structuredClone(builtin);
    const profile = this.list(session).find((x) => x.id === id);
    if (!profile) throw new ServiceError('not_found', 'Agent profile not found', 404);
    return profile;
  }
  /**
   * The task critic's grant (item 8): always the built-in salaam/reviewer, never another profile,
   * with no facts. It is granted under the work admission, not by an operator controller, and
   * only while the caller's authorize holds (the admitted plan declares a critic). The reviewer
   * reads only the immutable snapshot it is given and can only report findings.
   */
  async admitCritic(session: string, request: string, authorize: () => void): Promise<AgentGrant> {
    const profileId = 'salaam/reviewer';
    const profile = this.inspect(session, profileId);
    const expectedDigest = digest(profile);
    const input = { kind: 'critic-admit', session, profileId, expectedDigest };
    const saved = this.store.cachedRequest<AgentGrant>('task-critic', request, input);
    if (saved) return saved;
    if (!BUILTIN_PROFILES.some((p) => p.id === profileId && digest(p) === expectedDigest))
      throw new ServiceError('profile_changed', 'The critic must be the built-in reviewer');
    const prepared = await this.prepareRoute(this.route, session);
    return this.store.request('task-critic', request, input, () => {
      authorize();
      const grant: AgentGrant = {
        schema_version: 1,
        id: randomUUID(),
        owner_session: session,
        profile,
        profile_digest: expectedDigest,
        route: prepared.route,
        output_cap: prepared.output_cap,
        facts: [],
      };
      this.store.db
        .prepare(
          'INSERT INTO agent_grants(id,owner_session,profile_id,document,digest,state) VALUES (?,?,?,?,?,?)',
        )
        .run(grant.id, session, profileId, canonical(grant), digest(grant), 'active');
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO worker_profiles(id,revision,digest,document) VALUES (?,?,?,?)',
        )
        .run(profile.id, profile.revision, expectedDigest, canonical(profile));
      this.store.event(session, 'agent.admitted', {
        grant_id: grant.id,
        profile_id: profileId,
        profile_digest: expectedDigest,
        route: prepared.route,
        critic: true,
      });
      return grant;
    });
  }
  async admit(
    session: string,
    request: string,
    profileId: string,
    expectedDigest: string,
    factIds: string[],
    controller: Controller,
  ): Promise<AgentGrant> {
    const input = { kind: 'agent-admit', session, profileId, expectedDigest, factIds };
    const saved = this.store.cachedRequest<AgentGrant>('local-operator', request, input);
    if (saved) return saved;
    this.store.authorizeControl(session, controller);
    const profile = this.inspect(session, profileId);
    if (digest(profile) !== expectedDigest)
      throw new ServiceError('profile_changed', 'Review the current profile digest');
    const writing = profile.tools.some((tool) => ['salaam_files', 'salaam_command'].includes(tool));
    if (writing) {
      if (!this.assertExecution)
        throw new ServiceError(
          'profile_unavailable',
          'Writing roles require the parallel execution boundary',
        );
      this.assertExecution();
    }
    const prepared = await this.prepareRoute(
      profile.provider
        ? providerRoute(profile.provider, profile.model, Math.min(2048, this.route.max_tokens))
        : this.route,
      session,
    );
    return this.store.request('local-operator', request, input, () => {
      this.store.authorizeControl(session, controller);
      if (writing) this.assertExecution!();
      if (digest(this.inspect(session, profileId)) !== expectedDigest)
        throw new ServiceError('profile_changed', 'Profile changed during admission');
      if (
        profile.role &&
        !this.store.db.prepare('SELECT id FROM workspaces WHERE session_id=?').get(session)
      )
        throw new ServiceError(
          'workspace_unavailable',
          'Specialists need an admitted coding workspace',
        );
      if (factIds.length > 16 || new Set(factIds).size !== factIds.length)
        throw new ServiceError('invalid_profile', 'Select at most 16 distinct facts');
      const facts = factIds.map((id) => {
        const fact = this.store.db
          .prepare(
            'SELECT id,kind,text FROM task_facts WHERE id=? AND session_id=? AND id NOT IN (SELECT supersedes FROM task_facts WHERE supersedes IS NOT NULL)',
          )
          .get(id, session);
        if (!fact) throw new ServiceError('not_found', 'Selected fact is unavailable', 404);
        return { id: String(fact.id), kind: String(fact.kind), text: String(fact.text) };
      });
      const grant: AgentGrant = {
        schema_version: 1,
        id: randomUUID(),
        owner_session: session,
        profile,
        profile_digest: expectedDigest,
        route: prepared.route,
        output_cap: prepared.output_cap,
        facts,
      };
      const priorProfile = this.store.db
        .prepare('SELECT digest FROM worker_profiles WHERE id=? AND revision=?')
        .get(profile.id, profile.revision);
      if (priorProfile && priorProfile.digest !== expectedDigest)
        throw new ServiceError(
          'profile_revision_conflict',
          'Changed profile contents require a new revision',
        );
      this.store.db
        .prepare(
          'INSERT INTO agent_grants(id,owner_session,profile_id,document,digest,state) VALUES (?,?,?,?,?,?)',
        )
        .run(grant.id, session, profileId, canonical(grant), digest(grant), 'active');
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO worker_profiles(id,revision,digest,document) VALUES (?,?,?,?)',
        )
        .run(profile.id, profile.revision, expectedDigest, canonical(profile));
      this.store.event(session, 'agent.admitted', {
        grant_id: grant.id,
        profile_id: profileId,
        profile_digest: expectedDigest,
        route: prepared.route,
      });
      this.validateFrame?.(session);
      return grant;
    });
  }
  resolve(session: string, id: string): AgentGrant {
    const row = this.store.db
      .prepare(
        "SELECT document,digest FROM agent_grants WHERE owner_session=? AND profile_id=? AND state='active' ORDER BY rowid DESC LIMIT 1",
      )
      .get(session, id);
    if (!row)
      throw new ServiceError('authority_denied', 'Operator must admit this agent profile first');
    const grant = JSON.parse(String(row.document)) as AgentGrant;
    if (digest(grant) !== row.digest || digest(this.inspect(session, id)) !== grant.profile_digest)
      throw new ServiceError('profile_changed', 'Profile changed; renew its admission');
    return grant;
  }
  validate(grant: AgentGrant): void {
    const row = this.store.db
      .prepare('SELECT document,digest,state FROM agent_grants WHERE id=? AND owner_session=?')
      .get(grant.id, grant.owner_session);
    if (
      !row ||
      row.state !== 'active' ||
      row.digest !== digest(grant) ||
      row.document !== canonical(grant) ||
      digest(this.inspect(grant.owner_session, grant.profile.id)) !== grant.profile_digest
    )
      throw new ServiceError(
        'worker_profile_revoked',
        'Specialist admission was revoked or changed',
      );
  }
  revoke(session: string, grantId: string, request: string, controller: Controller): unknown {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'agent-revoke', session, grantId },
      () => {
        this.store.authorizeControl(session, controller);
        const result = this.store.db
          .prepare("UPDATE agent_grants SET state='revoked' WHERE id=? AND owner_session=?")
          .run(grantId, session);
        if (!result.changes) throw new ServiceError('not_found', 'Agent admission not found', 404);
        this.store.event(session, 'agent.revoked', { grant_id: grantId });
        return { grant_id: grantId, state: 'revoked' };
      },
    );
  }
  snapshot(session: string): AgentGrantSnapshot[] {
    return this.store.db
      .prepare(
        'SELECT document,state FROM agent_grants WHERE owner_session=? ORDER BY rowid DESC LIMIT 64',
      )
      .all(session)
      .reverse()
      .map((row) => {
        const grant = JSON.parse(String(row.document)) as AgentGrant;
        let state = String(row.state);
        if (state === 'active') {
          try {
            this.validate(grant);
          } catch {
            state = 'stale';
          }
        }
        return {
          grant_id: grant.id,
          profile_id: grant.profile.id,
          revision: grant.profile.revision,
          profile_digest: grant.profile_digest,
          tools: grant.profile.tools,
          role: grant.profile.role,
          route: grant.route,
          output_cap: grant.output_cap,
          selected_facts: grant.facts.map((f) => f.id),
          state,
        };
      });
  }
}
