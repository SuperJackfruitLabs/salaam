import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { planHost, readHost, type HostManifest } from './host.js';
import { acquireStateLock } from '../core/state-lock.js';
import { canonical, digest, object, string } from '../core/protocol.js';

// This setting is the complete, already reviewed output of `host plan`. It is
// never an arbitrary command, source transfer, permission or restart grant.
export const HOST_MANIFEST_SETTING = 'salaam.host.manifest';
const limit = 65536;
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
function privateRead(path: string, max = limit): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077 || st.size > max)
      throw Error('Configuration documents must be private owner-held bounded files');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function atomic(path: string, data: string) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  const parent = openSync(dirname(path), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
function manifestInput(value: unknown) {
  const m = object(value);
  if (![2, 3, 4, 5, 6].includes(m.schema as number) || m.mode !== 'agentpod')
    throw Error('Only reviewed AgentPod host manifests can be managed');
  const provider = object(m.provider);
  return {
    mode: 'agentpod',
    state: m.state,
    agentpod_config: m.agentpod_config,
    ...(provider.provider === 'salaam-proof'
      ? { provider: 'offline' }
      : {
          provider: provider.provider,
          model: provider.model,
          max_output_tokens: provider.max_tokens,
          ...(provider.workspace_id ? { workspace_id: provider.workspace_id } : {}),
        }),
    ...(m.managed_mcp ? { mcp_config: object(m.managed_mcp).config } : {}),
    ...(m.managed_toolkit ? { toolkit_config: object(m.managed_toolkit).config } : {}),
    ...(m.station_execution ? { station_config: object(m.station_execution).config } : {}),
    ...(m.schema === 6 ? { strict_work_version: 1 } : {}),
  };
}
function stationOf(m: Record<string, unknown>) {
  return (
    'salaam:' +
    createHash('sha256').update(string(m.workspace, 'workspace')).digest('hex').slice(0, 16)
  );
}
function assertIdentity(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  stationKey: string,
) {
  if (stationOf(before) !== stationKey || stationOf(after) !== stationKey)
    throw Error('Configuration belongs to another station');
  for (const key of ['state', 'workspace', 'agentpod_config', 'node', 'repo'])
    if (before[key] !== after[key])
      throw Error('Configuration cannot rebind host identity: ' + key);
}
function planDigest(plan: Record<string, unknown>) {
  const { planDigest: _digest, createdAt: _created, operationId: _operation, ...content } = plan;
  return digest(content);
}
type Entry = {
  settingId: string;
  file: string;
  keyPath: string;
  policy: string;
  current: unknown;
  intended: unknown;
  action: string;
  restartToTakeEffect: boolean;
};
type Plan = {
  schemaVersion: 1;
  operationId: string;
  stationKey: string;
  entries: Entry[];
  beforeSha256: string;
  diff: string;
  diffTruncated: boolean;
  noOp: boolean;
  restartRequired: boolean;
  createdAt: string;
  planDigest: string;
  refusal?: { code: string; message: string };
};
type Receipt = {
  plan: Plan;
  phase: string;
  updatedAt: string;
  written: { settingId: string; action: string; wrote: unknown }[];
  afterSha256?: string;
  error?: string;
};
type Saved = { requestDigest: string; target: string; receipt: Receipt };
function checkedRequest(value: unknown, action: string) {
  const r = object(value);
  const allowed =
    action === 'observe'
      ? ['stationKey', 'settings']
      : action === 'plan'
        ? ['stationKey', 'operationId', 'want']
        : action === 'apply'
          ? ['stationKey', 'operationId', 'planDigest']
          : ['stationKey', 'operationId'];
  if (Object.keys(r).some((k) => !allowed.includes(k)))
    throw Error('Unexpected configuration request field');
  string(r.stationKey, 'stationKey');
  if (action !== 'observe') {
    const id = string(r.operationId, 'operationId');
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id))
      throw Error('Invalid configuration operation identity');
  }
  return r;
}
/** Existing AgentPod config.manage v1 wire shapes; no daemon is started here. */
export async function hostConfiguration(
  path: string,
  action: string,
  value: unknown,
): Promise<any> {
  if (!['observe', 'plan', 'apply', 'inspect'].includes(action))
    throw Error('Unknown configuration action');
  if (
    !isAbsolute(path) ||
    realpathSync(dirname(path)) !== dirname(path) ||
    (existsSync(path) && realpathSync(path) !== path)
  )
    throw Error('Use a canonical absolute manifest path');
  const r = checkedRequest(value, action),
    stationKey = r.stationKey as string;
  if (action === 'observe') {
    if (!Array.isArray(r.settings) || r.settings.some((id) => id !== HOST_MANIFEST_SETTING))
      throw Error('Unknown configuration setting');
    // Observation has no lock, journal or state creation side effects.
    try {
      const m = readHost(path);
      if (m.schema === 1 || stationOf(m as unknown as Record<string, unknown>) !== stationKey)
        throw Error('Configuration belongs to another station');
      return {
        values: r.settings.map((settingId) => ({ settingId, readable: true, observed: m })),
      };
    } catch (error) {
      return {
        values: r.settings.map((settingId) => ({
          settingId,
          readable: false,
          reason: String(error),
        })),
      };
    }
  }
  const dir = join(dirname(path), '.agentpod', basename(path) + '.configuration');
  // Never follow a pre-existing journal directory symlink.
  let ancestor = dir;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor)
    throw Error('Configuration journal must not contain symlinks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir) throw Error('Configuration journal must not contain symlinks');
  const release = acquireStateLock(dir),
    journal = join(dir, 'operations.json');
  try {
    const records: Record<string, Saved> = Object.assign(
      Object.create(null),
      existsSync(journal) ? JSON.parse(privateRead(journal, 64 << 20)) : {},
    );
    const operationId = r.operationId as string;
    const existing = Object.hasOwn(records, operationId) ? records[operationId] : undefined;
    const save = () => atomic(journal, JSON.stringify(records) + '\n');
    if (existing && existing.receipt.plan.stationKey !== stationKey)
      throw Error('Configuration operation belongs to another station');
    if (action === 'inspect') {
      if (!existing) throw Error('No such configuration operation');
      return existing.receipt;
    }
    if (action === 'plan') {
      const requestDigest = digest(r);
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          throw Error('Configuration operation identity reused with different intent');
        return existing.receipt.plan;
      }
      const before = privateRead(path),
        current = object(JSON.parse(before));
      const plan: Plan = {
        schemaVersion: 1,
        operationId,
        stationKey,
        entries: [],
        beforeSha256: hash(before),
        diff: '',
        diffTruncated: false,
        noOp: false,
        restartRequired: false,
        createdAt: new Date().toISOString(),
        planDigest: '',
      };
      const refuse = (code: string, message: string) => {
        plan.refusal = { code, message };
        plan.planDigest = planDigest(plan);
        return plan;
      };
      if (!Array.isArray(r.want) || r.want.length !== 1)
        return refuse('SHAPE_UNEXPECTED', 'Declare exactly one reviewed host manifest');
      const want = object(r.want[0]);
      if (want.settingId !== HOST_MANIFEST_SETTING)
        return refuse('UNKNOWN_SETTING', 'Salaam manages only its reviewed host manifest');
      if (Object.keys(want).sort().join(',') !== 'settingId,value')
        return refuse('SHAPE_UNEXPECTED', 'Unexpected declared setting field');
      let target: HostManifest;
      try {
        const wanted = object(want.value);
        assertIdentity(current, wanted, stationKey);
        target = await planHost(manifestInput(wanted));
        if (canonical(target) !== canonical(wanted))
          throw Error(
            'Manifest differs from current source, package, runtime or configuration pins; run host plan again',
          );
      } catch (error) {
        return refuse('SHAPE_UNEXPECTED', String(error));
      }
      if (Buffer.byteLength(JSON.stringify(target)) > limit)
        return refuse('SHAPE_UNEXPECTED', 'Reviewed manifest exceeds limit');
      const noOp = canonical(current) === canonical(target),
        after = noOp ? before : JSON.stringify(target, null, 2) + '\n';
      plan.entries = [
        {
          settingId: HOST_MANIFEST_SETTING,
          file: path,
          keyPath: '$',
          policy: 'reconcilable',
          current,
          intended: target,
          action: noOp ? 'noop' : 'modify',
          restartToTakeEffect: true,
        },
      ];
      const rendered = noOp ? '' : '- ' + canonical(current) + '\n+ ' + canonical(target) + '\n';
      plan.diff = rendered.slice(0, 16384);
      plan.diffTruncated = rendered.length > 16384;
      plan.noOp = noOp;
      plan.restartRequired = !noOp;
      plan.planDigest = planDigest(plan);
      // Bound unfinished reviews instead of silently dropping one.
      if (Object.keys(records).length >= 256)
        throw Error('Configuration journal full; inspect retained operations');
      records[operationId] = {
        requestDigest,
        target: after,
        receipt: { plan, phase: 'planned', updatedAt: new Date().toISOString(), written: [] },
      };
      save();
      return plan;
    }
    if (!existing) throw Error('No such configuration operation');
    const conflict = (code: string, message: string) => ({
      ...existing.receipt,
      phase: 'conflict',
      updatedAt: new Date().toISOString(),
      error: code + ': ' + message,
    });
    if (r.planDigest !== existing.receipt.plan.planDigest)
      return conflict('PLAN_DIGEST_MISMATCH', 'Supplied digest does not match reviewed operation');
    // Saved success is replayed before fresh drift, runtime and busy checks.
    if (existing.receipt.phase === 'applied' || existing.receipt.phase === 'conflict')
      return existing.receipt;
    const plan = existing.receipt.plan,
      m = object(JSON.parse(existing.target)),
      releases: (() => void)[] = [];
    try {
      for (const lock of [
        join(string(m.state, 'state'), 'startup'),
        join(string(m.state, 'state'), 'host'),
        string(m.state, 'state'),
      ])
        releases.push(acquireStateLock(lock));
      const actual = privateRead(path);
      if (existing.receipt.phase === 'applying' && hash(actual) === hash(existing.target)) {
        // A durable write preceded the final receipt; finish the saved intent.
      } else if (hash(actual) !== plan.beforeSha256) {
        existing.receipt = conflict('PLAN_STALE', 'Manifest bytes changed after review');
        save();
        return existing.receipt;
      } else {
        try {
          const fresh = await planHost(manifestInput(m));
          if (canonical(fresh) !== canonical(m)) throw Error('Reviewed configuration pins changed');
        } catch (error) {
          existing.receipt = conflict('PLAN_STALE', String(error));
          save();
          return existing.receipt;
        }
        // Persist intent before the file replacement so crashes are inspectable.
        existing.receipt = {
          ...existing.receipt,
          phase: 'applying',
          updatedAt: new Date().toISOString(),
        };
        save();
        atomic(path, existing.target);
      }
      if (privateRead(path) !== existing.target) {
        existing.receipt = conflict('PLAN_STALE', 'Manifest changed during write');
        save();
        return existing.receipt;
      }
      existing.receipt = {
        plan,
        phase: 'applied',
        updatedAt: new Date().toISOString(),
        written: plan.entries.map((e) => ({
          settingId: e.settingId,
          action: e.action,
          wrote: e.intended,
        })),
        afterSha256: hash(existing.target),
      };
      save();
      return existing.receipt;
    } finally {
      releases.reverse().forEach((fn) => fn());
    }
  } finally {
    release();
  }
}
