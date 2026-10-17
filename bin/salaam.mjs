#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (process.versions.node !== pkg.engines.node) {
  console.error(
    `Salaam requires Node ${pkg.engines.node}; this shell is using ${process.version}.`,
  );
  process.exitCode = 1;
} else if (!existsSync(new URL('../dist/src/cli.js', import.meta.url))) {
  console.error('Salaam has not been built. Run npm run build in the Salaam checkout.');
  process.exitCode = 1;
} else {
  await import('../dist/src/cli.js');
}
