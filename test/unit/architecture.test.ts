import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

// The shape of src/, held by numbers that may only fall (the largest import cycle and the files
// over the size limit) and by rules between modules: one entry point each, layers that point down,
// no cycle. See docs/contributor/modularity-plan.md.

const SRC = join(import.meta.dirname, '../../src');
const SIZE_LIMIT = 1000;

/** Files over SIZE_LIMIT and the most lines each may have. Lower these; never raise them. */
const OVERSIZE: Record<string, number> = {
  'agentpod/work.ts': 3928,
  'tui/app.ts': 3262,
  'cli/cli.ts': 1924,
  'agentpod/station-work.ts': 1541,
  'local/coding.ts': 1363,
  'store/store.ts': 1341,
  'acp/server.ts': 1240,
  'tui/view.ts': 1169,
  'execution/managed.ts': 1004,
};
/** Files in the largest import cycle. Lower it; never raise it. */
const LARGEST_CYCLE = 5;

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

/** Modules from the bottom up. A module imports only from a layer below its own, never from its
 * own layer. The tui and acp are clients of the service (acp reuses the tui's socket client); the
 * cli is the program and composes everything. */
export const LAYERS: string[][] = [
  ['core'],
  ['store'],
  ['providers', 'execution', 'web'],
  ['coding', 'local', 'mcp'],
  ['workers', 'toolkit'],
  ['harness', 'runtime'],
  ['tasks'],
  ['agentpod', 'a2a'],
  ['service', 'host'],
  ['tui'],
  ['acp'],
  ['cli'],
];
/** Module edges that point up or across a layer, as 'from>to', each with its reason. This list may
 * only shrink. */
const KNOWN_BACK_EDGES: Record<string, string> = {};
/** Files that start a process of their own: Pi loads the house extension, and node runs the edit
 * and orphan helpers. They and every file they load import other modules' files directly, never
 * a module's index, so the process loads only what it needs. */
const PROCESS_ENTRIES = [
  'runtime/house-extension.ts',
  'local/edit-helper.ts',
  'execution/orphan.ts',
];
/** Files Pi loads with the house extension that bundleDigest in core/config.ts does not hash. */
const UNDIGESTED_HOUSE_FILES: string[] = [];

export interface Import {
  from: string;
  to: string;
  /** Loaded at run time, not only a type. */
  value: boolean;
  /** An `await import()`, which loads its file only when that code runs. */
  dynamic: boolean;
}

const moduleOf = (file: string): string => file.split('/')[0] ?? file;

export function imports(root = SRC): Import[] {
  const found: Import[] = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    const from = relative(root, file);
    const add = (spec: string, value: boolean, dynamic: boolean) => {
      const to = relative(root, resolve(dirname(file), spec + '.ts'));
      if (!to.startsWith('..')) found.push({ from, to, value, dynamic });
    };
    for (const m of text.matchAll(
      /^[ \t]*(?:import|export)\b(\s+type\b)?([^;']*?)\bfrom\s*'(\.{1,2}\/[^']+)\.js'/gm,
    )) {
      const names = (m[2] ?? '')
        .replace(/[{}]/g, '')
        .split(',')
        .map((n) => n.trim());
      const value = !m[1] && names.some((n) => n && !n.startsWith('type '));
      add(m[3] ?? '', value, false);
    }
    for (const m of text.matchAll(/(await\s+)?import\(\s*'(\.{1,2}\/[^']+)\.js'\s*\)/g))
      add(m[2] ?? '', !!m[1], !!m[1]);
  }
  return found;
}

/** Every file the entries load at run time, following static value imports. */
export function loadedBy(entries: string[], all: Import[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const i of all) if (i.from === file && i.value && !i.dynamic) queue.push(i.to);
  }
  return seen;
}

/** Cross-module imports that name a file instead of the module's index.ts. A dynamic import may
 * name a file so that it stays lazy; files a process entry loads are exempt (see PROCESS_ENTRIES). */
export function entryPointViolations(all: Import[], exempt: Set<string>): string[] {
  return all
    .filter(
      (i) =>
        moduleOf(i.from) !== moduleOf(i.to) &&
        i.to !== moduleOf(i.to) + '/index.ts' &&
        !i.dynamic &&
        !exempt.has(i.from),
    )
    .map((i) => `${i.from} -> ${i.to}`);
}

/** Module edges ('from>to') that do not point to a lower layer. */
export function layerViolations(all: Import[], layers: string[][]): string[] {
  const rank = new Map(layers.flatMap((layer, n) => layer.map((m) => [m, n] as const)));
  const bad = new Set<string>();
  for (const i of all) {
    const a = moduleOf(i.from),
      b = moduleOf(i.to);
    if (a === b) continue;
    if ((rank.get(a) ?? -1) <= (rank.get(b) ?? Infinity)) bad.add(`${a}>${b}`);
  }
  return [...bad].toSorted();
}

export function moduleGraph(all: Import[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const i of all) {
    const a = moduleOf(i.from),
      b = moduleOf(i.to);
    const out = graph.get(a) ?? [];
    if (a !== b && !out.includes(b)) out.push(b);
    graph.set(a, out);
  }
  return graph;
}

test('every module has a layer', () => {
  const modules = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
  expect(modules.toSorted()).toEqual(LAYERS.flat().toSorted());
});

test('modules import each other only through index.ts', () => {
  const all = imports();
  expect(entryPointViolations(all, loadedBy(PROCESS_ENTRIES, all))).toEqual([]);
});

test('a process entry loads no module index', () => {
  const loaded = [...loadedBy(PROCESS_ENTRIES, imports())];
  expect(loaded.filter((f) => f.endsWith('/index.ts'))).toEqual([]);
});

test('bundleDigest hashes every file Pi loads with the house extension', () => {
  const config = readFileSync(join(SRC, 'core/config.ts'), 'utf8');
  const loaded = [...loadedBy(['runtime/house-extension.ts'], imports())];
  const missing = loaded.filter(
    (f) =>
      !config.includes(`'dist/src/${f.replace(/\.ts$/, '.js')}'`) &&
      f !== 'runtime/house-extension.ts',
  );
  expect(missing.toSorted()).toEqual(UNDIGESTED_HOUSE_FILES);
});

test('module imports point down the layers', () => {
  const back = layerViolations(imports(), LAYERS);
  expect(back.filter((e) => !(e in KNOWN_BACK_EDGES))).toEqual([]);
  expect(
    Object.keys(KNOWN_BACK_EDGES).filter((e) => !back.includes(e)),
    'these back edges are gone; remove them from KNOWN_BACK_EDGES',
  ).toEqual([]);
});

test('no import cycle between modules', () => {
  expect(cycles(moduleGraph(imports()))).toEqual([]);
});

test('the module rules see what they should', () => {
  const at = (from: string, to: string, value = true, dynamic = false): Import => ({
    from,
    to,
    value,
    dynamic,
  });
  const all = [
    at('b/x.ts', 'a/index.ts'),
    at('b/x.ts', 'a/y.ts'),
    at('b/x.ts', 'a/z.ts', true, true),
    at('b/x.ts', 'b/w.ts'),
    at('a/y.ts', 'b/index.ts', false),
    at('p/entry.ts', 'a/y.ts'),
  ];
  expect(entryPointViolations(all, loadedBy(['p/entry.ts'], all))).toEqual(['b/x.ts -> a/y.ts']);
  expect([...loadedBy(['b/x.ts'], all)].toSorted()).toEqual([
    'a/index.ts',
    'a/y.ts',
    'b/w.ts',
    'b/x.ts',
  ]);
  expect(layerViolations(all, [['a'], ['b', 'p']])).toEqual(['a>b']);
  expect(cycles(moduleGraph(all))).toEqual([['a', 'b']]);
});

test('the docs-required workflow watches files that exist', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '../../.github/workflows/docs-required.yml'),
    'utf8',
  );
  const pattern = /grep -E '(\^src\/[^']+)'/.exec(workflow)?.[1];
  expect(pattern, 'the workflow names its watched files with grep -E').toBeDefined();
  const watched = new RegExp(pattern ?? '$^');
  const matched = sources(SRC)
    .map((f) => 'src/' + relative(SRC, f))
    .filter((f) => watched.test(f));
  // One alternative per watched file: a renamed file would silently drop out of the list.
  const alternatives = (pattern ?? '').split('|').length;
  expect(matched.length).toBe(alternatives);
});
