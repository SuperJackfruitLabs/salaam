import { copyFileSync } from 'node:fs';

// Keep the hosted installer identical to the canonical release installer.
copyFileSync(
  new URL('../install.sh', import.meta.url),
  new URL('../landing/public/install.sh', import.meta.url),
);
