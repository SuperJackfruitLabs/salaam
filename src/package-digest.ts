import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function packageDigest(root: string): string {
  const files: string[][] = [];
  function walk(relative = ''): void {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (name === 'node_modules') continue;
      const child = relative ? `${relative}/${name}` : name;
      const path = join(root, child);
      if (statSync(path).isDirectory()) walk(child);
      else files.push([child, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  }
  walk();
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
