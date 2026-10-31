#!/usr/bin/env node
// Live smoke for the built-in web search and fetch: real keyless APIs, no keys. Not part of the
// test suite (the CI evidence gate refuses skipped tests); run by hand after `npm run build`:
//   node scripts/web-search-smoke.mjs
import { WebSearch } from '../dist/src/web-search.js';
import { fetchPage } from '../dist/src/web-fetch.js';

const ws = new WebSearch();
const cases = [
  ['wiki', 'HTTP 403 Forbidden'],
  ['code', 'bubblewrap sandbox'],
  ['package', 'left-pad'],
  ['paper', 'large language model agents'],
  ['general', 'rust async runtime'],
];
let failed = 0;
for (const [kind, query] of cases) {
  const out = await ws.search({ query, kind, limit: 3 });
  const tried = out.tried.map((t) => `${t.backend}:${t.ok ? t.count : 'x'}(${t.ms}ms)`).join(' ');
  console.log(`${kind.padEnd(8)} ${String(out.results.length)} results  ${tried}`);
  for (const r of out.results.slice(0, 2))
    console.log(`           ${r.source}: ${r.title.slice(0, 60)} <${r.url}>`);
  if (!out.results.length) failed++;
}
const page = await fetchPage('https://www.rfc-editor.org/rfc/rfc9110.html');
console.log(
  `fetch    ${page.status} ${page.title.slice(0, 50)} — ${page.text.length} chars${page.truncated ? ' (truncated)' : ''}`,
);
try {
  await fetchPage('http://169.254.169.254/latest/meta-data/');
  console.log('guard    NOT refused');
  failed++;
} catch (e) {
  console.log('guard    refused metadata address: ' + e.message);
}
process.exit(failed ? 1 : 0);
