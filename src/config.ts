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
  version: 2,
  tools: ['salaam_probe', 'salaam_review', 'salaam_effect'],
  provider: 'salaam-proof',
  model: 'scripted',
  external_effects: 'explicit-connector-and-operation-approval',
};
export const POLICY_DIGEST = digest(POLICY);
export function bundleDigest(): string {
  const pin = JSON.parse(readFileSync(join(ROOT, 'pi-pin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(PI_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
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
    lock: textDigest(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')),
    house: textDigest(readFileSync(HOUSE_EXTENSION, 'utf8')),
    protocol: textDigest(readFileSync(join(ROOT, 'dist/src/protocol.js'), 'utf8')),
    transport: textDigest(readFileSync(join(ROOT, 'dist/src/transport.js'), 'utf8')),
  });
}
