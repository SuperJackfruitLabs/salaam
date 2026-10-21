import { digest, ServiceError } from './protocol.js';

export interface ReadinessFingerprint {
  session_id: string;
  worker_epoch: number;
  version: 1;
  harness: 'salaam';
  harness_version: string;
  pi_version: string;
  bundle_digest: string;
  policy_digest: string;
  provider: string;
  model: string;
  context_digest: string;
  context_admission_digest: string | null;
  verification: 'pinned-readiness-handshake';
  digest: string;
}

export function readinessFingerprint(
  input: Omit<ReadinessFingerprint, 'digest'>,
): ReadinessFingerprint {
  return verifyReadinessFingerprint({ ...input, digest: digest(input) });
}
export function verifyReadinessFingerprint(value: ReadinessFingerprint): ReadinessFingerprint {
  const { digest: recorded, ...input } = value;
  if (
    Object.keys(input).sort().join(',') !==
      'bundle_digest,context_admission_digest,context_digest,harness,harness_version,model,pi_version,policy_digest,provider,session_id,verification,version,worker_epoch' ||
    typeof input.session_id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(input.session_id) ||
    !Number.isSafeInteger(input.worker_epoch) ||
    input.worker_epoch < 1 ||
    input.version !== 1 ||
    input.harness !== 'salaam' ||
    input.verification !== 'pinned-readiness-handshake' ||
    ['harness_version', 'pi_version', 'provider', 'model'].some((key) => {
      const text = input[key as keyof typeof input];
      return (
        typeof text !== 'string' ||
        !text.length ||
        text.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(text)
      );
    }) ||
    [
      recorded,
      input.bundle_digest,
      input.policy_digest,
      input.context_digest,
      ...(input.context_admission_digest === null ? [] : [input.context_admission_digest]),
    ].some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
    digest(input) !== recorded
  )
    throw new ServiceError(
      'invalid_readiness_fingerprint',
      'Readiness fingerprint is inconsistent',
    );
  return value;
}
