import { object, ServiceError } from './protocol.js';
export interface WorkDecision {
  version: 1;
  request_id: string;
  work_request_id: string;
  binding_digest: string;
  task_id: string;
  plan_revision: number;
  operation_id: string;
  operation_digest: string;
  approval_id: string;
  approval_revision: number;
  expires_at: number;
  question: string;
  /** Readable approvals: what is being approved, as structured fields. */
  detail?: WorkDecisionDetail;
  options:
    | [{ id: 'approve'; title: string }, { id: 'deny'; title: string }]
    | [
        { id: 'approve'; title: string },
        { id: 'approve-run'; title: string },
        { id: 'deny'; title: string },
      ];
}
export interface WorkDecisionDetail {
  version: 1;
  summary: string;
  reason: string | null;
  files: {
    path: string;
    change: 'create' | 'edit' | 'delete';
    bytes: number | null;
    preview: string | null;
  }[];
  digest: string;
}
export interface WorkDecisionAnswer {
  version: 1;
  request_id: string;
  decision: WorkDecision;
  decision_digest: string;
  elicitation_id: string;
  option_id: 'approve' | 'approve-run' | 'deny';
  answered_by: string;
  answered_at: string;
}
function fail(): never {
  throw new ServiceError('invalid_work_decision', 'Exact versioned work decision required');
}
function keys(v: Record<string, unknown>, expected: string[]) {
  if (Object.keys(v).sort().join(',') !== expected.sort().join(',')) fail();
}
function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
function uuid(v: unknown) {
  return (
    typeof v === 'string' &&
    (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v) ||
      v === '00000000-0000-0000-0000-000000000000' ||
      v === 'ffffffff-ffff-ffff-ffff-ffffffffffff')
  );
}
export function workDecision(value: unknown): WorkDecision {
  const v = object(value);
  keys(v, [
    'version',
    'request_id',
    'work_request_id',
    'binding_digest',
    'task_id',
    'plan_revision',
    'operation_id',
    'operation_digest',
    'approval_id',
    'approval_revision',
    'expires_at',
    'question',
    'options',
    ...('detail' in v ? ['detail'] : []),
  ]);
  if ('detail' in v) workDecisionDetail(v.detail);
  if (
    v.version !== 1 ||
    !['request_id', 'work_request_id', 'task_id', 'operation_id', 'approval_id'].every((k) =>
      uuid(v[k]),
    ) ||
    !['binding_digest', 'operation_digest'].every(
      (k) => typeof v[k] === 'string' && /^[a-f0-9]{64}$/.test(v[k] as string),
    ) ||
    !['plan_revision', 'approval_revision', 'expires_at'].every(
      (k) => Number.isSafeInteger(v[k]) && Number(v[k]) > 0,
    ) ||
    !text(v.question, 8192) ||
    !Array.isArray(v.options) ||
    ![2, 3].includes(v.options.length)
  )
    fail();
  // approve, deny; or approve, approve-run (this run's writes), deny. Nothing else, in that order.
  const ids = v.options.length === 3 ? ['approve', 'approve-run', 'deny'] : ['approve', 'deny'];
  for (let i = 0; i < ids.length; i++) {
    const opt = object(v.options[i]);
    keys(opt, ['id', 'title']);
    if (opt.id !== ids[i] || !text(opt.title, 256)) fail();
  }
  return v as unknown as WorkDecision;
}
export function workDecisionAnswer(value: unknown): WorkDecisionAnswer {
  const v = object(value);
  keys(v, [
    'version',
    'request_id',
    'decision',
    'decision_digest',
    'elicitation_id',
    'option_id',
    'answered_by',
    'answered_at',
  ]);
  workDecision(v.decision);
  if (
    v.version !== 1 ||
    !uuid(v.request_id) ||
    typeof v.decision_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.decision_digest) ||
    !text(v.elicitation_id, 128) ||
    !/^elc_[A-Za-z0-9]{6,}$/.test(v.elicitation_id) ||
    !['approve', 'approve-run', 'deny'].includes(String(v.option_id)) ||
    !text(v.answered_by, 128) ||
    typeof v.answered_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v.answered_at) ||
    !Number.isFinite(Date.parse(v.answered_at)) ||
    new Date(v.answered_at).toISOString().slice(0, 19) !== v.answered_at.slice(0, 19)
  )
    fail();
  return v as unknown as WorkDecisionAnswer;
}

function workDecisionDetail(value: unknown): WorkDecisionDetail {
  const d = object(value);
  keys(d, ['version', 'summary', 'reason', 'files', 'digest']);
  if (
    d.version !== 1 ||
    !text(d.summary, 200) ||
    (d.reason !== null && !text(d.reason, 300)) ||
    typeof d.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(d.digest) ||
    !Array.isArray(d.files) ||
    d.files.length > 16
  )
    fail();
  for (const f of d.files as unknown[]) {
    const file = object(f);
    keys(file, ['path', 'change', 'bytes', 'preview']);
    if (
      !text(file.path, 512) ||
      !['create', 'edit', 'delete'].includes(String(file.change)) ||
      (file.bytes !== null && (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0)) ||
      (file.preview !== null && (typeof file.preview !== 'string' || file.preview.length > 1200))
    )
      fail();
  }
  return d as unknown as WorkDecisionDetail;
}
