import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';
import { root } from './release-check.mjs';

// Rewrites the docs' generated reference tables from the built registries. Run through
// `npm run docs:generate`, which builds first; test/unit/docs-reference.test.ts fails while
// a committed table differs from this output.
const { regenerate } = await import(join(root, 'dist/src/docs-reference.js'));
const options = await prettier.resolveConfig(join(root, 'docs/index.md'));
for (const page of ['tui', 'cli']) {
  const file = join(root, 'docs', page + '.md');
  const before = readFileSync(file, 'utf8');
  const after = await prettier.format(regenerate(before), { ...options, filepath: file });
  if (after !== before) {
    writeFileSync(file, after);
    console.log('updated docs/' + page + '.md');
  }
}
