#!/usr/bin/env node
// Type-aware lint with a ratchet. Rules with existing findings are counted in
// scripts/lint-baseline.json; a count may fall but never rise, and a rule missing from the
// baseline must be clean, and an improvement must be locked in. `npm run lint -- --update` lowers the baseline after a cleanup and
// refuses to raise it; a rule that reaches zero leaves the baseline and must then stay clean.
// SRC_CLEAN rules must have no findings in src/ at all, whatever the baseline allows elsewhere.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts/lint-baseline.json');
const update = process.argv.includes('--update');

const run = spawnSync(
  join(root, 'node_modules/.bin/oxlint'),
  ['--type-aware', '--format', 'json', 'src', 'test', 'scripts', 'bin'],
  { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
if (run.error) throw run.error;
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  process.stderr.write(run.stderr || run.stdout);
  process.exit(2);
}

const findings = report.diagnostics;
const counts = {};
for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

// Rules src/ must stay clean of whatever the baseline allows elsewhere (tests, scripts).
const SRC_CLEAN = new Set([
  'eslint(no-console)',
  'eslint(no-empty)',
  'eslint(no-unused-vars)',
  'eslint(no-useless-concat)',
  'typescript(consistent-type-imports)',
  'typescript(no-explicit-any)',
  'typescript(no-unnecessary-boolean-literal-compare)',
  'typescript(no-unnecessary-type-assertion)',
  'typescript(no-unnecessary-type-conversion)',
  'typescript(restrict-template-expressions)',
  'typescript(unbound-method)',
  'unicorn(no-useless-fallback-in-spread)',
  'unicorn(no-useless-spread)',
  'unicorn(prefer-string-starts-ends-with)',
]);
const unclean = findings.filter((f) => SRC_CLEAN.has(f.code) && f.filename.startsWith('src/'));
if (unclean.length) {
  for (const f of unclean.slice(0, 40)) {
    const at = f.labels?.[0]?.span;
    console.error(`${f.code}: ${f.filename}${at ? ':' + at.line : ''}  ${f.message}`);
  }
  console.error(`lint: ${unclean.length} findings in src/ for rules src/ must keep clean`);
  process.exit(1);
}

const raised = Object.entries(counts).filter(([rule, n]) => n > (baseline[rule] ?? 0));
if (raised.length) {
  for (const [rule, n] of raised) {
    console.error(`${rule}: ${n} findings, the baseline allows ${baseline[rule] ?? 0}`);
    for (const f of findings.filter((x) => x.code === rule).slice(0, 20)) {
      const at = f.labels?.[0]?.span;
      console.error(`  ${f.filename}${at ? ':' + at.line : ''}  ${f.message}`);
    }
  }
  process.exit(1);
}

const lowered = Object.keys(baseline).filter((rule) => (counts[rule] ?? 0) < baseline[rule]);
if (update) {
  const next = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(
    `lint baseline: ${findings.length} findings across ${Object.keys(next).length} rules`,
  );
} else if (lowered.length) {
  // A stale baseline would let the count creep back up unnoticed.
  console.error(`lint: ${lowered.join(', ')} improved; run npm run lint -- --update to lock it in`);
  process.exit(1);
} else {
  console.log(`lint: ok (${findings.length} findings held by the baseline)`);
}
