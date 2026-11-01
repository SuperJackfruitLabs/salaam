import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { toolkitCatalogReview } from './mcp.js';
import type { ToolkitWorkConfig } from './work.js';
import { digest, object, ServiceError } from '../core/index.js';

function refused(): never {
  throw new ServiceError(
    'toolkit_config_changed',
    'Reviewed private native Toolkit configuration is unavailable or changed',
  );
}
function privateFile(path: string, limit: number): Buffer {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    refused();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.nlink !== 1 ||
      before.size > limit
    )
      refused();
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      leaf = lstatSync(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1 ||
      leaf.ino !== before.ino ||
      leaf.dev !== before.dev ||
      leaf.isSymbolicLink()
    )
      refused();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** Host planning verifies immutable private references without opening credential
 * stores, materializing callback keys or pretending that a catalogue is ready.
 * Actual root/private launch and protocol admission still precede worker startup. */
export function readToolkitConfig(
  path: string,
  expectedDigest?: string,
  workspace?: string,
): ToolkitWorkConfig {
  try {
    const value = object(JSON.parse(privateFile(path, 262144).toString('utf8')));
    if (
      Object.keys(value).sort().join(',') !== 'catalog,profile_path,profile_sha256,version' ||
      value.version !== 1 ||
      typeof value.profile_path !== 'string' ||
      typeof value.profile_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.profile_sha256)
    )
      refused();
    const config: ToolkitWorkConfig = {
      profile_path: value.profile_path,
      profile_sha256: value.profile_sha256,
      catalog: toolkitCatalogReview(value.catalog),
    };
    const profile = privateFile(config.profile_path, 65536);
    if (createHash('sha256').update(profile).digest('hex') !== config.profile_sha256) refused();
    if (expectedDigest !== undefined && digest(config) !== expectedDigest) refused();
    if (workspace)
      for (const privatePath of [path, config.profile_path])
        if (privatePath === workspace || privatePath.startsWith(workspace + sep)) refused();
    return config;
  } catch {
    refused();
  }
}
