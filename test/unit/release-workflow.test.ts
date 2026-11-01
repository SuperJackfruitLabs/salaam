import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/core/config.js';

// GitHub refuses to start a workflow whose called job asks for a permission the caller does not
// grant. release.yml calls ci.yml, so when ci.yml's `plan` job gained `pull-requests: read`
// (2026-10-24) every release failed at startup until v0.0.4's tag found it. Read both files and
// hold the caller to everything the called jobs ask for.
const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };

/** The `permissions:` maps in a workflow, by the indentation of their `permissions:` line. */
function permissionBlocks(
  text: string,
): { indent: number; line: number; grants: Map<string, string> }[] {
  const lines = text.split('\n');
  const blocks: { indent: number; line: number; grants: Map<string, string> }[] = [];
  lines.forEach((line, i) => {
    const m = /^( *)permissions:\s*$/.exec(line);
    if (!m) return;
    const indent = m[1]!.length;
    const grants = new Map<string, string>();
    for (let j = i + 1; j < lines.length; j++) {
      const entry = /^( *)([a-z-]+):\s*(read|write|none)\s*$/.exec(lines[j]!);
      if (!entry || entry[1]!.length <= indent) break;
      grants.set(entry[2]!, entry[3]!);
    }
    blocks.push({ indent, line: i + 1, grants });
  });
  return blocks;
}

test('release.yml grants every permission the ci.yml jobs it calls ask for', () => {
  const workflows = join(ROOT, '.github/workflows');
  const release = readFileSync(join(workflows, 'release.yml'), 'utf8');
  const ci = readFileSync(join(workflows, 'ci.yml'), 'utf8');

  // The job in release.yml that calls ci.yml, and the permissions it grants that call.
  const lines = release.split('\n');
  const callAt = lines.findIndex((l) => /^\s+uses: \.\/\.github\/workflows\/ci\.yml\s*$/.test(l));
  expect(callAt).toBeGreaterThan(-1);
  const callIndent = /^( *)/.exec(lines[callAt]!)![1]!.length;
  const granted = permissionBlocks(lines.slice(callAt).join('\n')).find(
    (b) => b.indent === callIndent,
  );
  expect(granted, 'the ci.yml call in release.yml sets its permissions').toBeTruthy();

  // Every job-level permissions block in ci.yml (job blocks are indented under `jobs:`).
  const asked = permissionBlocks(ci).filter((b) => b.indent > 0);
  expect(asked.length).toBeGreaterThan(0);
  const missing: string[] = [];
  for (const block of asked)
    for (const [scope, level] of block.grants)
      if (LEVEL[granted!.grants.get(scope) ?? 'none']! < LEVEL[level]!)
        missing.push(`ci.yml:${block.line} ${scope}: ${level}`);
  expect(missing).toEqual([]);
});
