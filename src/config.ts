import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, textDigest } from './protocol.js';
import { packageDigest } from './package-digest.js';

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'pi-pin.json'))) {
  const parent = dirname(root);
  if (parent === root) throw new Error('Salaam package root not found');
  root = parent;
}
export const ROOT = root;
export const PI_ROOT = resolve(
  dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
  '..',
);
export const PI_CLI = join(PI_ROOT, 'dist/bundle/cli.js');
export const HOUSE_EXTENSION = join(ROOT, 'dist/src/house-extension.js');
export const POLICY = {
  version: 6,
  tools: [
    'salaam_probe',
    'salaam_review',
    'salaam_effect',
    'spawn_child',
    'inspect_child',
    'consume_child_result',
    'salaam_history',
    'salaam_files',
    'salaam_command',
  ],
  children: {
    maxDepth: 1,
    maxConcurrent: 2,
    parentRequestBudget: 16,
    maxChildRequestBudget: 8,
    authority: ['salaam_probe'],
  },
  providers: [
    'salaam-proof/scripted',
    'anthropic/claude-sonnet-5-5',
    'anthropic/claude-sonnet-4-6',
  ],
  provider_retries: 0,
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
    claude: textDigest(readFileSync(join(ROOT, 'dist/src/claude-provider.js'), 'utf8')),
    provider_config: textDigest(readFileSync(join(ROOT, 'dist/src/provider-config.js'), 'utf8')),
    protocol: textDigest(readFileSync(join(ROOT, 'dist/src/protocol.js'), 'utf8')),
    transport: textDigest(readFileSync(join(ROOT, 'dist/src/transport.js'), 'utf8')),
  });
}
