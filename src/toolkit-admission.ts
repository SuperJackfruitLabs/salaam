import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentpodBinding, type AgentPodBinding } from './agentpod-protocol.js';
import type { StdioLaunch } from './mcp-stdio.js';
import type { ToolkitResources } from './toolkit-resources.js';
import { digest, object, ServiceError } from './protocol.js';

const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function refused(): never {
  throw new ServiceError(
    'toolkit_profile_changed',
    'Reviewed private Toolkit admission is unavailable or changed',
  );
}
function exact(value: Record<string, unknown>, keys: string): void {
  if (Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) refused();
}
function outside(base: string, path: string): boolean {
  const r = relative(base, path);
  return r === '..' || r.startsWith('..' + sep);
}
function path(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    realpathSync(value) !== value
  )
    refused();
  return value;
}
function privateDirectory(value: unknown): string {
  const p = path(value),
    st = lstatSync(p);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077) refused();
  // Private leaves cannot be replaced through a group/world-writable ancestor.
  // Root-owned sticky /tmp is allowed; the owner-only child remains protected.
  for (let parent = dirname(p); ; parent = dirname(parent)) {
    const info = lstatSync(parent);
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      (info.mode & 0o022 && !(info.uid === 0 && info.mode & 0o1000))
    )
      refused();
    if (dirname(parent) === parent) break;
  }
  return p;
}
function privateFile(value: unknown, root: string, limit: number, executable = false): Buffer {
  const p = path(value);
  if (outside(root, p) || p === root) refused();
  privateDirectory(dirname(p));
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077 ||
      st.nlink !== 1 ||
      st.size > limit ||
      (executable && !(st.mode & 0o100))
    )
      refused();
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      leaf = lstatSync(p);
    if (
      after.size !== st.size ||
      after.mtimeMs !== st.mtimeMs ||
      after.ctimeMs !== st.ctimeMs ||
      after.nlink !== 1 ||
      leaf.ino !== st.ino ||
      leaf.dev !== st.dev ||
      leaf.isSymbolicLink()
    )
      refused();
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Host-private launch admission only. It grants neither effect permission nor
 * sandbox isolation. The controller must also check current authority, actual
 * process ownership and the exact worker/attempt/call at each native grant.
 * This is deliberately not a public host capability until that controller exists. */
export class ToolkitAdmission {
  private parent?: ToolkitAdmission;
  constructor(
    private readonly profilePath: string,
    private readonly expectedDigest: string,
  ) {}

  /** Materialize an execution-only child from the immutable reviewed template.
   * Only the callback key and private manifest/profile locations change. The
   * original credential delegation and all original pins are checked again at
   * every use of the child. A generated hash never replaces host review.
   *
   * Private files are synced before returning; registration in ToolkitOwners
   * and ToolkitResources still must precede starting the process. A crash here
   * can leave inert private files, never a registered key or an adopted process.
   * No cleanup role or permission to change principal/root is implied. */
  materialize(binding: AgentPodBinding): ToolkitAdmission {
    try {
      if (this.parent) refused();
      const admitted = this.launch(binding),
        root = admitted.launch.env.HOME!;
      const sourceProfile = privateFile(this.profilePath, root, 65536),
        sourceManifest = privateFile(admitted.launch.args[2]!, root, 65536);
      // Recheck after reading both inputs; neither an unpinned file nor a
      // partially updated operator template may become a fresh child baseline.
      if (
        sha(sourceProfile) !== this.expectedDigest ||
        sha(sourceManifest) !== admitted.manifest_digest
      )
        refused();
      this.launch(binding);
      const profile = object(JSON.parse(sourceProfile.toString('utf8'))),
        template = object(JSON.parse(sourceManifest.toString('utf8')));
      const directory = privateDirectory(mkdtempSync(join(root, 'execution-'))),
        manifestPath = join(directory, 'manifest.json'),
        profilePath = join(directory, 'profile.json'),
        manifestBytes = Buffer.from(
          JSON.stringify({ ...template, owner_key: randomBytes(32).toString('hex') }),
        ),
        profileBytes = Buffer.from(
          JSON.stringify({
            ...profile,
            manifest: { path: manifestPath, sha256: sha(manifestBytes) },
          }),
        );
      for (const [file, bytes] of [
        [manifestPath, manifestBytes],
        [profilePath, profileBytes],
      ] as const) {
        const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      for (const dir of [directory, root]) {
        const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      const child = new ToolkitAdmission(profilePath, sha(profileBytes));
      child.parent = this;
      child.launch(binding);
      return child;
    } catch {
      refused();
    }
  }

  /** Only a hash leaves admission; the actual owner key stays in the private
   * manifest read by the pinned broker. This grants no callback permission. */
  ownerKeyDigest(binding: AgentPodBinding, socketPath: string): string {
    try {
      const admitted = this.launch(binding),
        manifestPath = admitted.launch.args[2]!;
      const bytes = privateFile(manifestPath, dirname(manifestPath), 65536);
      if (sha(bytes) !== admitted.manifest_digest) refused();
      const manifest = object(JSON.parse(bytes.toString('utf8')));
      if (manifest.owner_socket !== socketPath || !hash(manifest.owner_key)) refused();
      return sha(Buffer.from(manifest.owner_key));
    } catch {
      refused();
    }
  }

  /** Trusted parent seam: checks private admission at prepare, OS launch, PID
   * persistence and every SDK delivery. Native effect callbacks must ALSO check
   * assertLive and their own exact durable call/permission before issuing grants. */
  transport(resources: ToolkitResources, session: string, resourceId: string) {
    const binding = resources.authority?.binding(session);
    if (!binding) refused();
    const admitted = this.launch(binding);
    return resources.transport(
      {
        id: resourceId,
        session_id: session,
        root_digest: digest(binding),
        profile_digest: admitted.profile_digest,
        manifest_digest: admitted.manifest_digest,
        state_dir: admitted.state_dir,
        launch_digest: digest(admitted.launch),
      },
      admitted.launch,
      () => {
        const current = resources.authority?.binding(session);
        if (!current) refused();
        this.launch(current);
      },
    );
  }

  launch(binding: AgentPodBinding): {
    launch: StdioLaunch;
    profile_digest: string;
    manifest_digest: string;
    state_dir: string;
  } {
    try {
      this.parent?.launch(binding);
      binding = agentpodBinding(binding);
      if (!hash(this.expectedDigest)) refused();
      const profilePath = path(this.profilePath),
        profileDir = privateDirectory(dirname(profilePath));
      const bytes = privateFile(profilePath, profileDir, 65536);
      if (sha(bytes) !== this.expectedDigest) refused();
      const p = object(JSON.parse(bytes.toString('utf8')));
      exact(
        p,
        'version,kind,private_dir,credential_delegation,executable,manifest,passphrase_sha256,limits',
      );
      if (p.version !== 1 || p.kind !== 'stk-native-managed-v1') refused();
      const root = privateDirectory(p.private_dir);
      if (
        outside(root, profilePath) ||
        !outside(binding.workspace, root) ||
        !outside(root, binding.workspace)
      )
        refused();
      const grant = object(p.credential_delegation);
      exact(grant, 'organization_id,principal_id,binding_digest');
      if (
        grant.organization_id !== binding.organization_id ||
        grant.principal_id !== binding.principal_id ||
        grant.binding_digest !== digest(binding)
      )
        refused();
      const executable = object(p.executable),
        manifest = object(p.manifest);
      exact(executable, 'path,sha256');
      exact(manifest, 'path,sha256');
      if (!hash(executable.sha256) || !hash(manifest.sha256) || !hash(p.passphrase_sha256))
        refused();
      if (sha(privateFile(executable.path, root, 256 * 1024 * 1024, true)) !== executable.sha256)
        refused();
      const manifestBytes = privateFile(manifest.path, root, 65536);
      if (sha(manifestBytes) !== manifest.sha256) refused();
      const m = object(JSON.parse(manifestBytes.toString('utf8')));
      exact(
        m,
        'version,root_digest,profile_digest,workspace,policy_path,policy_sha256,profile,store_dir,passphrase_file,state_dir,owner_socket,owner_key',
      );
      if (
        m.version !== 1 ||
        m.root_digest !== digest(binding) ||
        m.workspace !== binding.workspace ||
        typeof m.profile !== 'string' ||
        (m.profile !== '' && !/^[A-Za-z0-9_.:-]{1,128}$/.test(m.profile)) ||
        !hash(m.owner_key) ||
        !hash(m.policy_sha256) ||
        m.profile_digest !==
          digest({
            version: 1,
            kind: 'stk-native-managed-v1',
            protocol: '2025-06-18',
            policy_sha256: m.policy_sha256,
            profile: m.profile,
          })
      )
        refused();
      path(binding.workspace);
      if (!lstatSync(binding.workspace).isDirectory()) refused();
      if (
        sha(privateFile(m.policy_path, root, 262144)) !== m.policy_sha256 ||
        sha(privateFile(m.passphrase_file, root, 16384)) !== p.passphrase_sha256
      )
        refused();
      for (const d of [m.store_dir, m.state_dir]) {
        const dir = privateDirectory(d);
        if (dir === root || outside(root, dir)) refused();
      }
      const socket = path(m.owner_socket),
        info = lstatSync(socket);
      if (
        outside(root, socket) ||
        !info.isSocket() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        refused();
      privateDirectory(dirname(socket));
      const limits = object(p.limits);
      exact(limits, 'request_bytes,response_bytes,stderr_bytes,timeout_ms');
      if (
        Object.values(limits).some(
          (n) => !Number.isSafeInteger(n) || Number(n) < 256 || Number(n) > 4 * 1024 * 1024,
        ) ||
        Number(limits.timeout_ms) > 120000
      )
        refused();
      return {
        launch: {
          command: executable.path as string,
          executable_digest: executable.sha256,
          args: [
            'managed-mcp-v1',
            '--manifest',
            manifest.path as string,
            '--sha256',
            manifest.sha256,
          ],
          cwd: binding.workspace,
          env: { HOME: root },
          protocol_version: '2025-06-18',
          limits: limits as unknown as StdioLaunch['limits'],
        },
        profile_digest: m.profile_digest as string,
        manifest_digest: manifest.sha256,
        state_dir: m.state_dir as string,
      };
    } catch {
      refused();
    }
  }
}
