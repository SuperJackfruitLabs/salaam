import { object, ServiceError } from './protocol.js';
import { stationHash } from './station-config.js';

/** Consumer of AgentPod's private salaam-station-files-v1 primitive. A process
 * exit or an arbitrary JSON object is not a content-bound filesystem receipt. */
export function stationFileResult(
  request: Record<string, unknown>,
  value: unknown,
): Record<string, any> {
  const v = object(value),
    hash = /^[a-f0-9]{64}$/;
  const bad = (): never => {
    throw new ServiceError('station_files_protocol', 'Protected station file receipt is invalid');
  };
  const keys: Record<string, string[]> = {
    inspect: [],
    list: ['entries', 'next_offset'],
    search: ['entries', 'next_offset'],
    read: ['path', 'content', 'sha256'],
    patch: ['path', 'sha256', 'before_tree_digest'],
    snapshot: ['snapshot', 'bytes'],
  };
  const fields = keys[String(request.action)];
  if (!fields) bad();
  if (
    Object.keys(v).sort().join(',') !==
      ['version', 'ok', 'tree_digest', 'files', 'root_identity', ...fields!].sort().join(',') ||
    v.version !== 1 ||
    v.ok !== true ||
    v.root_identity !== request.root_identity ||
    typeof v.root_identity !== 'string' ||
    !hash.test(v.root_identity) ||
    typeof v.tree_digest !== 'string' ||
    !hash.test(v.tree_digest) ||
    !Number.isSafeInteger(v.files) ||
    Number(v.files) < 0 ||
    Number(v.files) > 100000
  )
    bad();
  if (request.action === 'read') {
    if (
      v.path !== request.path ||
      typeof v.content !== 'string' ||
      Buffer.byteLength(v.content) > 256 * 1024 ||
      Buffer.from(v.content).toString('utf8') !== v.content ||
      v.sha256 !== stationHash(Buffer.from(v.content))
    )
      bad();
  }
  if (request.action === 'patch') {
    if (
      v.path !== request.path ||
      v.before_tree_digest !== request.expected_tree ||
      v.sha256 !==
        (request.content === null ? null : stationHash(Buffer.from(String(request.content))))
    )
      bad();
  }
  if (
    request.action === 'snapshot' &&
    (v.snapshot !== request.snapshot ||
      v.tree_digest !== request.expected_tree ||
      !Number.isSafeInteger(v.bytes) ||
      Number(v.bytes) < 0 ||
      Number(v.bytes) > 512 * 1024 * 1024)
  )
    bad();
  if (request.action === 'list' || request.action === 'search') {
    if (
      !Array.isArray(v.entries) ||
      v.entries.length > 40 ||
      (v.next_offset !== null &&
        (!Number.isSafeInteger(v.next_offset) || Number(v.next_offset) < 0))
    )
      bad();
    for (const value of v.entries as unknown[]) {
      const e = object(value);
      if (
        Object.keys(e).sort().join(',') !== 'bytes,ctime,dev,inode,mode,mtime,path' ||
        typeof e.path !== 'string' ||
        e.path.length > 512 ||
        e.path.startsWith('/') ||
        e.path.split('/').some((p) => !p || p === '.' || p === '..') ||
        /[\\\x00-\x1f\x7f]/.test(e.path) ||
        !['bytes', 'dev', 'inode', 'mode'].every(
          (k) => Number.isSafeInteger(e[k]) && Number(e[k]) >= 0,
        )
      )
        bad();
      for (const t of ['ctime', 'mtime']) {
        const time = object(e[t]);
        if (
          Object.keys(time).sort().join(',') !== 'Nsec,Sec' ||
          !Number.isSafeInteger(time.Sec) ||
          !Number.isSafeInteger(time.Nsec) ||
          Number(time.Nsec) < 0 ||
          Number(time.Nsec) >= 1e9
        )
          bad();
      }
    }
  }
  return v;
}
