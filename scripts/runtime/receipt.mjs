export const privateRuntimeImage =
  'docker.io/library/node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32';
export function validatePrivateRuntimeReceipt(receipt, expected, packageSha) {
  if (
    !receipt ||
    receipt.schema !== 1 ||
    receipt.kind !== 'salaam-private-runtime-container-proof' ||
    receipt.success !== true ||
    receipt.commit !== expected.commit ||
    String(receipt.workflow_run_id) !== String(expected.run_id) ||
    !Number.isInteger(receipt.workflow_run_attempt) ||
    receipt.workflow_run_attempt < 1 ||
    receipt.workflow_run_attempt > expected.run_attempt ||
    receipt.version !== expected.version ||
    receipt.package_sha256 !== packageSha ||
    receipt.image !== privateRuntimeImage ||
    !/^[a-f0-9]{64}$/.test(receipt.archive_sha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.manifest_sha256) ||
    receipt.platform !== 'linux' ||
    receipt.arch !== 'x64' ||
    receipt.network !== 'none' ||
    receipt.source_checkout_required !== false ||
    receipt.deployed_fleet !== false ||
    ![
      'system_node_absent',
      'installed_offline',
      'absolute_private_node',
      'concurrent_starts_single_owner',
      'pinned_pi_readiness',
      'offline_turn',
      'reconnect_preserves_attempt',
    ].every((key) => receipt[key] === true)
  )
    throw Error('Missing, stale or incomplete private runtime container proof');
  return receipt;
}
