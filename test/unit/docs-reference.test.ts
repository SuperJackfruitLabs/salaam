import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';
import { test, expect } from 'vitest';
import { lintDocs, regenerate, sourceTextOf } from '../../src/docs-reference.js';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const pages = (JSON.parse(read('docs-site/pages.json')) as string[]).map((slug) => ({
  file: `docs/${slug}.md`,
  text: read(`docs/${slug}.md`),
}));
pages.push({ file: 'README.md', text: read('README.md') });

test('the generated reference tables match the code (run npm run docs:generate)', async () => {
  const options = await prettier.resolveConfig(join(root, 'docs/index.md'));
  for (const page of ['docs/tui.md', 'docs/cli.md']) {
    const text = read(page);
    expect(text).toContain('<!-- generated:');
    const fresh = await prettier.format(regenerate(text), { ...options, filepath: page });
    expect(fresh, page + ' is stale; run npm run docs:generate').toBe(text);
  }
});

test('every slash command, CLI option, variable and config file the docs name exists', () => {
  expect(lintDocs(pages, sourceTextOf(join(root, 'src')))).toEqual([]);
});

test('the lint catches a removed command, option, variable and file', () => {
  const problems = lintDocs(
    [
      {
        file: 'x.md',
        text: [
          'Use `/teleport` here.',
          '```sh',
          'salaam service start --warp-drive',
          'salaam launch',
          '```',
          'Set `SALAAM_NOT_A_THING=1` in `~/.config/salaam/nowhere.json`.',
        ].join('\n'),
      },
    ],
    sourceTextOf(join(root, 'src')),
  ).map((p) => p.problem);
  expect(problems).toEqual([
    '/teleport is not a slash command',
    'salaam service has no --warp-drive option',
    'salaam launch is not a command',
    'SALAAM_NOT_A_THING is not read by the code',
    '~/.config/salaam/nowhere.json is not used by the code',
  ]);
});

test('a stale table is caught: a new command changes the rendered block', () => {
  const stale = '<!-- generated:slash-commands -->\n| old |\n<!-- /generated:slash-commands -->';
  expect(regenerate(stale)).toContain('`/rewind [turn]`');
  expect(regenerate(stale)).not.toContain('| old |');
});
