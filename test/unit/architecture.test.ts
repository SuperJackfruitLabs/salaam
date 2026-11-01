import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

// The shape of src/, held by numbers that may only fall: the largest import cycle and the files
// over the size limit. See docs/contributor/modularity-plan.md.

const SRC = join(import.meta.dirname, '../../src');
const SIZE_LIMIT = 1000;

/** Files over SIZE_LIMIT and the most lines each may have. Lower these; never raise them. */
const OVERSIZE: Record<string, number> = {
  'agentpod-work.ts': 3924,
  'service.ts': 3548,
  'tui.ts': 3265,
  'supervisor.ts': 2150,
  'cli.ts': 1922,
  'station-work.ts': 1570,
  'house-extension.ts': 1420,
  'local-coding.ts': 1356,
  'store.ts': 1338,
  'acp.ts': 1245,
  'tui-view.ts': 1169,
  'managed.ts': 1004,
};
/** Files in the largest import cycle. Lower it; never raise it. */
const LARGEST_CYCLE = 89;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

export function importGraph(root = SRC): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    const targets = new Set<string>();
    for (const m of text.matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)\.js'/g))
      if (m[1]) targets.add(relative(root, resolve(dirname(file), m[1] + '.ts')));
    graph.set(
      relative(root, file),
      [...targets].filter((t) => !t.startsWith('..')),
    );
  }
  return graph;
}

/** Strongly connected components with more than one file (Tarjan). */
export function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop();
      if (w === undefined) break;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) found.push(component.toSorted());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

test('no import cycle grows past the recorded size', () => {
  const largest = Math.max(0, ...cycles(importGraph()).map((c) => c.length));
  expect(largest, 'the largest import cycle grew').toBeLessThanOrEqual(LARGEST_CYCLE);
  expect(largest, 'the cycle shrank; lower LARGEST_CYCLE to lock it in').toBe(LARGEST_CYCLE);
});

test('no source file grows past the size limit', () => {
  const sizes = new Map(
    sources(SRC).map((f) => [relative(SRC, f), readFileSync(f, 'utf8').split('\n').length - 1]),
  );
  const over = [...sizes].filter(([, n]) => n > SIZE_LIMIT);
  for (const [file, n] of over)
    expect(
      n,
      `${file} has ${n} lines; the limit is ${OVERSIZE[file] ?? SIZE_LIMIT}`,
    ).toBeLessThanOrEqual(OVERSIZE[file] ?? SIZE_LIMIT);
  const stale = Object.keys(OVERSIZE).filter((f) => (sizes.get(f) ?? 0) < (OVERSIZE[f] ?? 0));
  expect(stale, 'these files shrank; lower or remove their OVERSIZE entry').toEqual([]);
});

test('the cycle finder sees a cycle and nothing else', () => {
  const graph = new Map([
    ['a.ts', ['b.ts']],
    ['b.ts', ['c.ts']],
    ['c.ts', ['a.ts']],
    ['d.ts', ['a.ts']],
  ]);
  expect(cycles(graph)).toEqual([['a.ts', 'b.ts', 'c.ts']]);
});
