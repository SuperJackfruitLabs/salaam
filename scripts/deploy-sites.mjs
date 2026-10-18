import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './release-check.mjs';

if (!process.argv.includes('--built'))
  execFileSync('npm', ['run', 'sites:build'], { cwd: root, stdio: 'inherit' });
else
  execFileSync(process.execPath, [join(root, 'scripts/check-sites.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
// Explicit config/cwd prevents Wrangler's framework auto-detection from rewriting Astro.
const scratch = mkdtempSync(join(tmpdir(), 'sal-sites-'));
try {
  for (const name of ['landing', 'docs-site']) {
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--config',
        join(root, name, 'wrangler.jsonc'),
        '--cwd',
        join(root, name),
        ...(process.argv.includes('--dry-run') ? ['--dry-run'] : []),
      ],
      { cwd: scratch, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
