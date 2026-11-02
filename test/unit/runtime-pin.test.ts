import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// scripts/private-runtime-pack.mjs refuses to pack when its state-schema pin disagrees with the
// newest schema the packaged Store opens. It reads that number from source, so a move or a rename
// would only fail when the Linux pack runs in CI. Check the same thing here.
const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('the runtime pin matches the newest schema the store opens', () => {
  const pack = read('scripts/private-runtime-pack.mjs');
  expect(pack).toContain("'app/node_modules/@superjackfruitlabs/salaam/src/store/schema.ts'");
  expect(pack).toContain('/const NEWEST_SCHEMA = (\\d+);/');
  const newest = /const NEWEST_SCHEMA = (\d+);/.exec(read('src/store/schema.ts'))?.[1];
  expect(newest).toBeDefined();
  const pin = JSON.parse(read('scripts/runtime-pin.json')) as { state_schema: { max: number } };
  expect(Number(newest)).toBe(pin.state_schema.max);
});
