import { readFileSync } from 'node:fs';
import { ROOT, PI_ROOT, bundleDigest } from '../dist/src/core/config.js';
import { join } from 'node:path';

const pin = JSON.parse(readFileSync(join(ROOT, 'pi-pin.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(PI_ROOT, 'package.json'), 'utf8'));
console.log(
  JSON.stringify(
    {
      package: pkg.name,
      version: pkg.version,
      integrity: pin.integrity,
      bundle_digest: bundleDigest(),
      provenance: pin.provenance,
    },
    null,
    2,
  ),
);
