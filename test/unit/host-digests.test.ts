import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { hashTree } from '../../src/core/config.js';

test('the source digest covers files in nested module folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'sal-hash-tree-'));
  try {
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'core', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'notes.md'), 'not code\n');
    const before = hashTree(root);
    writeFileSync(join(root, 'core', 'a.ts'), 'export const a = 2;\n');
    expect(hashTree(root)).not.toBe(before);
    writeFileSync(join(root, 'notes.md'), 'still not code\n');
    const after = hashTree(root);
    expect(hashTree(root)).toBe(after);
    mkdirSync(join(root, 'store'));
    writeFileSync(join(root, 'store', 'a.ts'), 'export const a = 2;\n');
    expect(hashTree(root)).not.toBe(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
