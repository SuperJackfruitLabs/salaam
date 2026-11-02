import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

// Scripts, fixtures and the bin load the build by path (dist/src/<file>.js) and are not type
// checked, so a moved file or symbol only fails when that script runs, often only in CI on Linux.
// Every such path must name a source file, and every name imported from it must be exported.

const ROOT = join(import.meta.dirname, '../..');
const ROOTS = ['scripts', 'bin', 'test/fixtures', 'test/acceptance', 'harness-runtime'];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(mjs|js|ts|sh|yml)$/.test(name) ? [path] : [];
  });
}

/** Names a file exports, including `export { a, b as c }` re-exports. */
function exportsOf(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  ))
    if (m[1]) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of (m[1] ?? '').split(','))
      names.add(
        part
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? '',
      );
  return names;
}

const references = ROOTS.flatMap((r) => files(join(ROOT, r))).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  const found: { file: string; path: string; names: string[] }[] = [];
  for (const m of text.matchAll(
    /(?:import\s*(?:\{([^}]*)\}\s*from\s*)?|const\s*\{([^}]*)\}\s*=\s*await\s+import\([^)]*?)?['"`][^'"`]*?dist\/src\/([\w/-]+)\.js['"`]/g,
  )) {
    const names = (m[1] ?? m[2] ?? '')
      .split(',')
      .map((n) =>
        n
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+|\s*:\s*/)[0]
          ?.trim(),
      )
      .filter((n): n is string => Boolean(n));
    if (m[3]) found.push({ file: relative(ROOT, file), path: m[3], names });
  }
  return found;
});

test('every dist/src path in scripts and fixtures names a source file', () => {
  expect(references.length).toBeGreaterThan(50);
  const missing = references
    .filter((r) => !existsSync(join(ROOT, 'src', r.path + '.ts')))
    .map((r) => `${r.file}: dist/src/${r.path}.js`);
  expect(missing).toEqual([]);
});

test('every name imported from dist/src is exported there', () => {
  const missing = references.flatMap((r) => {
    const source = join(ROOT, 'src', r.path + '.ts');
    if (!existsSync(source)) return [];
    const exported = exportsOf(readFileSync(source, 'utf8'));
    return r.names.filter((n) => !exported.has(n)).map((n) => `${r.file}: ${n} from ${r.path}`);
  });
  expect(missing).toEqual([]);
});
