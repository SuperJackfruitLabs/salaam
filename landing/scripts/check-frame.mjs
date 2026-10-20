// Run after `astro build`: the suite frame must be in the built HTML, and the old masthead must be gone.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const failures = [];
for (const tag of ['<sjl-suite-bar', '<sjl-product-header', '<sjl-claims', '<sjl-street']) {
  if (!html.includes(tag)) failures.push(`missing ${tag}`);
}
if (/<header class="masthead/.test(html)) failures.push('old masthead still present');
if (html.includes('x-sjl-preview')) failures.push('x-sjl-preview present');
const hero = html.indexOf('class="hero"');
const claims = html.indexOf('<sjl-claims');
if (hero !== -1 && claims !== -1 && claims < hero) failures.push('claims sit above the hero');
if (failures.length) {
  console.error(`check-frame: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('check-frame: ok');
