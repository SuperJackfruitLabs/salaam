import { agentpodBinding, type AgentPodBinding } from './protocol.js';
import { canonical, object, ServiceError, string } from '../core/protocol.js';

export interface AgentPodWorkIdentity {
  board_id: string;
  card_id: string;
  stage_key: string;
  input_digest: string;
  plan_digest: string;
}
export interface AgentPodWorkBinding {
  binding: AgentPodBinding;
  work: AgentPodWorkIdentity;
}
export interface AgentPodWorkAdmission extends AgentPodWorkBinding {
  version: 1;
  request_id: string;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(','))
    throw new ServiceError('invalid_work_admission', 'Unsupported work admission fields');
}
function clean(value: unknown, name: string, max = 128): string {
  const text = string(value, name, max);
  if (/[\u0000-\u001f\u007f]/.test(text))
    throw new ServiceError('invalid_work_admission', 'Control characters in work identity');
  return text;
}
function binding(value: unknown): AgentPodWorkBinding {
  const input = object(value);
  keys(input, ['binding', 'work']);
  const owner = agentpodBinding(input.binding);
  if (owner.run.source !== 'superpipeline' || !/^run_[A-Za-z0-9]{6,}$/.test(owner.run.id))
    throw new ServiceError(
      'invalid_work_admission',
      'Strict work requires Superpipeline authority',
    );
  for (const value of Object.values(owner))
    if (typeof value === 'string') clean(value, 'authority', 4096);
  clean(owner.run.id, 'run');
  const raw = object(input.work);
  keys(raw, ['board_id', 'card_id', 'stage_key', 'input_digest', 'plan_digest']);
  const work: AgentPodWorkIdentity = {
    board_id: clean(raw.board_id, 'board'),
    card_id: clean(raw.card_id, 'card'),
    stage_key: clean(raw.stage_key, 'stage'),
    input_digest: clean(raw.input_digest, 'input digest', 64),
    plan_digest: clean(raw.plan_digest, 'plan digest', 64),
  };
  if (
    !/^brd_[A-Za-z0-9]{6,}$/.test(work.board_id) ||
    !/^card_[A-Za-z0-9]{6,}$/.test(work.card_id) ||
    !/^[a-f0-9]{64}$/.test(work.input_digest) ||
    !/^[a-f0-9]{64}$/.test(work.plan_digest)
  )
    throw new ServiceError('invalid_work_admission', 'Invalid work identity or digest');
  return { binding: owner, work };
}
/** Mirror of AgentPod's unused private v1 contract. This grants no capability. */
export function agentpodWorkAdmission(value: unknown): AgentPodWorkAdmission {
  const input = object(value);
  keys(input, ['version', 'request_id', 'binding', 'work']);
  const request = clean(input.request_id, 'request');
  if (
    input.version !== 1 ||
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request) &&
      request !== '00000000-0000-0000-0000-000000000000' &&
      request !== 'ffffffff-ffff-ffff-ffff-ffffffffffff')
  )
    throw new ServiceError('invalid_work_admission', 'Invalid work admission version or request');
  return {
    version: 1,
    request_id: request,
    ...binding({ binding: input.binding, work: input.work }),
  };
}
export type WorkCheck =
  { ok: true; admission: AgentPodWorkAdmission } | { ok: false; code: string };
export function checkAgentPodWorkAdmission(value: unknown, expected: unknown): WorkCheck {
  let admission: AgentPodWorkAdmission, owner: AgentPodWorkBinding;
  try {
    admission = agentpodWorkAdmission(value);
  } catch {
    return { ok: false, code: 'invalid_work_admission' };
  }
  try {
    owner = binding(expected);
  } catch {
    return { ok: false, code: 'invalid_work_binding' };
  }
  if (canonical(admission.binding) !== canonical(owner.binding))
    return { ok: false, code: 'work_authority_mismatch' };
  if (canonical(admission.work) !== canonical(owner.work))
    return { ok: false, code: 'work_input_mismatch' };
  return { ok: true, admission };
}
export function checkAgentPodWorkReplay(value: unknown, saved: unknown): WorkCheck {
  let admission: AgentPodWorkAdmission, original: AgentPodWorkAdmission;
  try {
    admission = agentpodWorkAdmission(value);
  } catch {
    return { ok: false, code: 'invalid_work_admission' };
  }
  try {
    original = agentpodWorkAdmission(saved);
  } catch {
    return { ok: false, code: 'invalid_work_record' };
  }
  return canonical(admission) === canonical(original)
    ? { ok: true, admission: original }
    : { ok: false, code: 'work_request_conflict' };
}
