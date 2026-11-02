#!/usr/bin/env node
// Prints PREV=<tag> for the release summary: the given previous tag, or else the version tag just
// before <tag>. A final release skips prereleases, so v0.0.8 is summarised against v0.0.7, never
// v0.0.8-rc.1. No dependencies: the summary job runs without npm install.
import { execFileSync } from 'node:child_process';

const VERSION = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Orders version tags oldest first; a prerelease sorts before its final release. */
export function compareTags(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) throw new Error(`not a version tag: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++)
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  return x[4].localeCompare(y[4], 'en', { numeric: true });
}

export function previousTag(tag, tags) {
  if (!VERSION.test(tag)) throw new Error(`not a version tag: ${tag}`);
  const final = !VERSION.exec(tag)[4];
  const older = tags
    .filter((t) => VERSION.test(t) && compareTags(t, tag) < 0)
    .filter((t) => !final || !VERSION.exec(t)[4])
    .toSorted(compareTags);
  return older.at(-1) ?? null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tag, given] = process.argv.slice(2);
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n');
  const prev = given || previousTag(tag ?? '', tags);
  if (!prev) throw new Error(`no version tag before ${tag}`);
  console.log(`PREV=${prev}`);
}
