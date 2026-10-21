import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, posix } from 'node:path';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function inventory(root, prefix = '') {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      const path = posix.join(prefix, name);
      if (/[\x00-\x1f\x7f\\]/.test(path)) throw Error(`Unsupported payload filename: ${path}`);
      if (path === 'runtime.json') return [];
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) return inventory(root, path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(join(root, path));
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (posix.isAbsolute(target) || resolved === '..' || resolved.startsWith('../'))
          throw Error(`Escaping symlink: ${path}`);
        return [{ path, target }];
      }
      if (!stat.isFile() || stat.mode & 0o6000) throw Error(`Unsupported payload: ${path}`);
      return [{ path, mode: stat.mode & 0o777, sha256: hash(readFileSync(join(root, path))) }];
    });
}
export function verify(root) {
  const bytes = readFileSync(join(root, 'runtime.json'));
  const manifest = JSON.parse(bytes);
  if (
    manifest.schema !== 1 ||
    manifest.platform !== `${process.platform}-${process.arch}` ||
    manifest.node !== process.versions.node ||
    !Number.isInteger(manifest.state_schema?.max) ||
    manifest.state_schema.min !== 0 ||
    manifest.state_schema.max < 0 ||
    JSON.stringify(manifest.files) !== JSON.stringify(inventory(root))
  )
    throw Error('Private runtime manifest or payload mismatch');
  return { manifest, digest: hash(bytes) };
}
