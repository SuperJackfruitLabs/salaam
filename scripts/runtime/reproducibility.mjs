import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash } from './inventory.mjs';

export function verifyReproducibleBuilds(first, second, firstArchive, secondArchive) {
  const firstHash = hash(readFileSync(firstArchive));
  const secondHash = hash(readFileSync(secondArchive));
  if (
    !/^[a-f0-9]{64}$/.test(first.manifest_sha256) ||
    first.sha256 !== firstHash ||
    second.sha256 !== secondHash ||
    firstHash !== secondHash ||
    first.manifest_sha256 !== second.manifest_sha256 ||
    first.version !== second.version
  )
    throw Error('Independent private runtime builds are not byte-identical');
  return {
    reproducible_two_builds: true,
    archive_sha256: firstHash,
    manifest_sha256: first.manifest_sha256,
    rebuild_archive_sha256: secondHash,
    rebuild_manifest_sha256: second.manifest_sha256,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [firstRecord, secondRecord, firstArchive, secondArchive] = process.argv.slice(2);
  if (!secondArchive) throw Error('Supply two build records and their two archives');
  console.log(
    JSON.stringify(
      verifyReproducibleBuilds(
        JSON.parse(readFileSync(firstRecord)),
        JSON.parse(readFileSync(secondRecord)),
        firstArchive,
        secondArchive,
      ),
    ),
  );
}
