import { expect, test } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { MentionAutocompleteProvider } from '../../src/tui-mentions.js';

function provider() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sal-ac-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), '');
  writeFileSync(join(root, 'my notes.md'), '');
  writeFileSync(join(root, '.gitignore'), 'secret.log\n');
  writeFileSync(join(root, 'secret.log'), '');
  return new MentionAutocompleteProvider([{ name: 'help', description: 'Help' }], root);
}
const signal = new AbortController().signal;

test('@ completes workspace files without fd, quoting names with spaces', async () => {
  const p = provider();
  const got = await p.getSuggestions(['look at @app'], 0, 12, { signal });
  expect(got).toMatchObject({
    prefix: '@app',
    items: [{ value: '@src/app.ts', description: 'src/app.ts' }],
  });
  const spaced = await p.getSuggestions(['@notes'], 0, 6, { signal });
  expect(spaced!.items[0]!.value).toBe('@"my notes.md"');
  expect(await p.getSuggestions(['@secret'], 0, 7, { signal })).toBeNull();
});

test('an email address and slash commands keep their old behaviour', async () => {
  const p = provider();
  expect(await p.getSuggestions(['mail me@app'], 0, 11, { signal })).toBeNull();
  const slash = await p.getSuggestions(['/he'], 0, 3, { signal });
  expect(slash!.items.map((i) => i.value)).toContain('help');
});

test('picking a file puts the mention in the line with a trailing space', async () => {
  const p = provider();
  const got = (await p.getSuggestions(['see @app'], 0, 8, { signal }))!;
  expect(p.applyCompletion(['see @app'], 0, 8, got.items[0]!, got.prefix).lines).toEqual([
    'see @src/app.ts ',
  ]);
});
