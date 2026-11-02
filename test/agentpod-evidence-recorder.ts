// Phase 5 (modularity): the evidence AgentPod work records when it retires or expires a run is
// pinned byte for byte, so splitting the failure checks into rules cannot change a query's order,
// a row, a key or its position. The evidence never leaves the process except as a digest, so the
// core module's digest() is wrapped (vi.mock in each test file) and every evidence object it is
// handed is recorded, in call order, per test. Values that differ per run (ids, paths, digests,
// times) are replaced by names in order of first appearance; everything else is compared, as the
// exact JSON text, so key order is pinned too. Update with SALAAM_UPDATE_EVIDENCE=1.
import { afterEach, beforeEach, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type * as CoreModule from '../src/core/index.js';
import type * as CryptoModule from 'node:crypto';

type Core = typeof CoreModule;
type Crypto = typeof CryptoModule;

const EXPECTED = new URL('./unit/__snapshots__/agentpod-work-evidence.json', import.meta.url);
const UPDATE = process.env.SALAAM_UPDATE_EVIDENCE === '1';

let seen: string[] = [];
let uuids = 0;
const testNames = new Set<string>();

/** The digested objects that are run evidence: a known-effects retirement (fail and status), an
 * expiry's historical evidence, and an abandonment's. */
function isEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.includes('binding') && keys.includes('blocked_reason') && keys.includes('task_id')) ||
    (keys.includes('producer_terminal_digest') &&
      (keys.includes('history') || keys.includes('several_review_offers'))) ||
    keys.includes('checkEvidence')
  );
}

/** The core module with digest() recording evidence before it hashes it. */
export function recordingCore(core: Core): Core {
  return {
    ...core,
    digest: (value: unknown) => {
      if (isEvidence(value)) seen.push(JSON.stringify(value));
      return core.digest(value);
    },
  };
}

/** node:crypto with randomUUID() counting from zero in each test. Rows a query returns in id
 * order (no ORDER BY) then come back in the same order on every run, so the recorded evidence
 * is the same on every run too; the ids are still distinct well-formed v4 UUIDs. */
export function countingCrypto(crypto: Crypto): Crypto {
  return {
    ...crypto,
    randomUUID: () =>
      `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}` as const,
  };
}

/** Per-run values become stable names, numbered by first appearance in this test's evidence. */
export function normalizeEvidence(texts: string[]): string[] {
  const names = new Map<string, string>();
  const name = (kind: string) => (value: string) => {
    let found = names.get(value);
    if (!found) {
      found = `<${kind}${[...names.values()].filter((n) => n.startsWith('<' + kind)).length + 1}>`;
      names.set(value, found);
    }
    return found;
  };
  return texts.map((text) =>
    text
      .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^"\\]*?sal-[A-Za-z0-9_-]+/g, name('path'))
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, name('uuid'))
      .replace(/(?<![0-9a-z])[a-f0-9]{16,64}(?![0-9a-z])/g, name('hex'))
      .replace(/(?<![0-9])1[0-9]{12}(?![0-9])/g, '<time>'),
  );
}

function expected(): Record<string, string[]> {
  if (!existsSync(EXPECTED)) return {};
  const saved: unknown = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const all: Record<string, string[]> = {};
  if (saved && typeof saved === 'object')
    for (const [name, texts] of Object.entries(saved))
      if (Array.isArray(texts)) all[name] = texts.map(String);
  return all;
}

/** Registers the per-test comparison in the calling test file. */
export function characterizeEvidence(): void {
  beforeEach(() => {
    seen = [];
    uuids = 0;
  });
  afterEach((context) => {
    const name = context.task.name;
    // Evidence is keyed by test name, so a name may not repeat.
    expect(testNames.has(name), `test name "${name}" repeats`).toBe(false);
    testNames.add(name);
    const actual = normalizeEvidence(seen);
    seen = [];
    if (UPDATE) {
      const all = expected();
      if (actual.length) all[name] = actual;
      else delete all[name];
      const sorted = Object.fromEntries(
        Object.entries(all).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      writeFileSync(EXPECTED, JSON.stringify(sorted, null, 2) + '\n');
      return;
    }
    const dump = process.env.SALAAM_EVIDENCE_DUMP;
    if (dump) writeFileSync(dump, JSON.stringify({ [name]: actual }) + '\n', { flag: 'a' });
    expect(actual, `recorded evidence for "${name}"`).toEqual(expected()[name] ?? []);
  });
}
