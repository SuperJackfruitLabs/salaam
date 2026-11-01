import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, textDigest } from './protocol.js';
import { PI_PROVIDERS } from './provider-catalog.js';
import { packageDigest } from './package-digest.js';

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'pi-pin.json'))) {
  const parent = dirname(root);
  if (parent === root) throw new Error('Salaam package root not found');
  root = parent;
}
export const ROOT = root;
export const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
export const PI_VERSION: string = JSON.parse(
  readFileSync(join(ROOT, 'pi-pin.json'), 'utf8'),
).version;
export const PI_ROOT = resolve(
  dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  '..',
);
export const PI_CLI = join(PI_ROOT, 'dist/bundle/cli.js');
export const HOUSE_EXTENSION = join(ROOT, 'dist/src/runtime/house-extension.js');
export const POLICY = {
  version: 16,
  tools: [
    'salaam_workspace',
    'salaam_local',
    'salaam_probe',
    'salaam_review',
    'salaam_effect',
    'spawn_child',
    'inspect_child',
    'consume_child_result',
    'salaam_history',
    'salaam_files',
    'salaam_command',
    'salaam_repository',
    'salaam_findings',
    'salaam_team',
  ],
  children: {
    maxDepth: 1,
    maxConcurrent: 2,
    parentRequestBudget: 16,
    maxChildRequestBudget: 8,
    authority: ['salaam_probe'],
    worker_boundary: 'frozen-native-model-request-v1',
    specialist_profiles: 'operator-admitted-snapshot-v1',
    team_claims: 'task-step-generation-v1',
    daemon_workers: 8,
    messages: 'passive-durable-explicit-ack-v1',
    writing: 'owned-draft-explicit-hash-bound-integration-v1',
    external: 'operator-pinned-whole-runtime-explicit-invocation-v1',
    a2a: 'pinned-peer-one-turn-analysis-explicit-invocation-v1',
  },
  providers: [
    'salaam-proof/scripted',
    ...PI_PROVIDERS.flatMap((provider) =>
      provider.getModels().map((model) => provider.id + '/' + model.id),
    ).sort(),
  ],
  provider_retries: 0,
  task_token_budget: 'capped-default-explicit-null-opt-out-v1',
  compaction: { strategy: 'explicit-task-checkpoint-v1', automatic: false, keepRecentTokens: 512 },
  external_effects: 'explicit-connector-and-operation-approval',
  coding: {
    workspace: 'owned-copy-v1',
    commands: 'disposable-copy-v1',
    network: 'none',
    persistent_edits: 'hash-bound-patch-only',
  },
};
export const POLICY_DIGEST = digest(POLICY);
export function bundleDigest(): string {
  const pin = JSON.parse(readFileSync(join(ROOT, 'pi-pin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(PI_ROOT, 'package.json'), 'utf8'));
  // npm omits package-lock.json from tarballs. Release packages carry the same
  // reviewed bytes as npm-shrinkwrap.json, alongside bundled production dependencies.
  const lockPath = join(
    ROOT,
    existsSync(join(ROOT, 'npm-shrinkwrap.json')) ? 'npm-shrinkwrap.json' : 'package-lock.json',
  );
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const artifact = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
  if (
    pkg.version !== pin.version ||
    artifact?.version !== pin.version ||
    artifact?.integrity !== pin.integrity
  )
    throw new Error('Installed Pi does not match pin and lockfile');
  for (const [name, expected] of Object.entries(pin.packageDigests as Record<string, string>)) {
    if (packageDigest(join(ROOT, 'node_modules', name)) !== expected)
      throw new Error(`Installed package content changed: ${name}`);
  }
  return digest({
    pin,
    policy: POLICY_DIGEST,
    lock: textDigest(readFileSync(lockPath, 'utf8')),
    house: textDigest(readFileSync(HOUSE_EXTENSION, 'utf8')),
    provider_usage: textDigest(readFileSync(join(ROOT, 'dist/src/providers/usage.js'), 'utf8')),
    provider_model: textDigest(readFileSync(join(ROOT, 'dist/src/providers/model.js'), 'utf8')),
    live_provider: textDigest(
      readFileSync(join(ROOT, 'dist/src/providers/live-provider.js'), 'utf8'),
    ),
    acp_outcome: textDigest(readFileSync(join(ROOT, 'dist/src/core/outcome.js'), 'utf8')),
    provider_payload: textDigest(readFileSync(join(ROOT, 'dist/src/providers/payload.js'), 'utf8')),
    provider_transport: textDigest(
      readFileSync(join(ROOT, 'dist/src/providers/transport.js'), 'utf8'),
    ),
    provider_auth: textDigest(readFileSync(join(ROOT, 'dist/src/providers/auth.js'), 'utf8')),
    claude: textDigest(readFileSync(join(ROOT, 'dist/src/providers/claude-provider.js'), 'utf8')),
    provider_config: textDigest(readFileSync(join(ROOT, 'dist/src/providers/config.js'), 'utf8')),
    provider_catalog: textDigest(
      readFileSync(join(ROOT, 'dist/src/core/provider-catalog.js'), 'utf8'),
    ),
    provider_route: textDigest(readFileSync(join(ROOT, 'dist/src/core/provider-route.js'), 'utf8')),
    protocol: textDigest(readFileSync(join(ROOT, 'dist/src/core/protocol.js'), 'utf8')),
    worker_boundary: textDigest(
      readFileSync(join(ROOT, 'dist/src/store/worker-boundary.js'), 'utf8'),
    ),
    worker_binding: textDigest(readFileSync(join(ROOT, 'dist/src/core/worker-binding.js'), 'utf8')),
    persona: textDigest(readFileSync(join(ROOT, 'dist/src/runtime/persona.js'), 'utf8')),
    agent_profiles: textDigest(
      readFileSync(join(ROOT, 'dist/src/runtime/agent-profiles.js'), 'utf8'),
    ),
    team_work: textDigest(readFileSync(join(ROOT, 'dist/src/tasks/team-work.js'), 'utf8')),
    worker_workspaces: textDigest(
      readFileSync(join(ROOT, 'dist/src/workers/worker-workspaces.js'), 'utf8'),
    ),
    repository_snapshots: textDigest(
      readFileSync(join(ROOT, 'dist/src/workers/repository-snapshots.js'), 'utf8'),
    ),
    transport: textDigest(readFileSync(join(ROOT, 'dist/src/core/transport.js'), 'utf8')),
  });
}
/** Every .ts/.js file under `top`, by its path relative to `top`, so a nested file counts. */
export function hashTree(top: string): string {
  const files: { file: string; content: string }[] = [];
  const visit = (dir: string, prefix: string): void => {
    // Code-unit order: the digest must not depend on the host's locale.
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel + '/');
      else if (/\.(ts|js)$/.test(entry.name))
        files.push({ file: rel, content: readFileSync(join(dir, entry.name), 'utf8') });
    }
  };
  visit(top, '');
  return digest(files);
}
export function hostDigests() {
  return {
    source_digest: hashTree(join(ROOT, 'src')),
    build_digest: hashTree(join(ROOT, 'dist/src')),
    pi_bundle_digest: bundleDigest(),
  };
}
