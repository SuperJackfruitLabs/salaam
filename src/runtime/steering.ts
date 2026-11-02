// Steering: a person's message delivered into the active local model turn. Its intent is saved
// before delivery; a lost receipt is recorded and never replayed.
import { ServiceError, type Controller } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { Worker } from './worker.js';

export async function steerTurn(
  store: Store,
  workerOf: () => Worker | undefined,
  id: string,
  request: string,
  text: string,
  controller: Controller,
) {
  const input = { kind: 'steer', id, text };
  const saved = store.cachedRequest<{ state: string }>('local-operator', request, input);
  if (saved) return saved;
  const worker = workerOf();
  const intent = store.request('local-operator', request, input, () => {
    store.authorizeControl(id, controller);
    store.execution.assert(id);
    if (
      !store.localWorkspace(id) ||
      !worker?.ready ||
      worker.invalid ||
      worker.stopping ||
      !worker.pi ||
      !worker.busy ||
      !worker.attempt
    )
      throw new ServiceError(
        'steer_unavailable',
        'Steering requires an active local model turn; use /queue for the next turn',
      );
    if (store.hasUnknown(id))
      throw new ServiceError('outcome_unknown', 'Resolve uncertain work before steering');
    if (store.attempt(worker.attempt).state !== 'running')
      throw new ServiceError('steer_unavailable', 'The active attempt is no longer running');
    const receipt = { state: 'delivery_unknown', attempt: worker.attempt, epoch: worker.epoch };
    store.event(id, 'steering.saved', { ...receipt, text }, request);
    return receipt;
  });
  try {
    await worker!.pi!.command('steer', { message: text });
    return store.transaction(() => {
      const receipt = { ...intent, state: 'received' };
      store.event(id, 'steering.received', receipt, request);
      store.db
        .prepare('UPDATE requests SET response=? WHERE actor=? AND id=?')
        .run(JSON.stringify(receipt), 'local-operator', request);
      return receipt;
    });
  } catch {
    // The worker may have received it. Never retry this message across reconnect/restart.
    store.transaction(() => store.event(id, 'steering.delivery_unknown', intent, request));
    throw new ServiceError(
      'steer_delivery_unknown',
      'Steering receipt was lost. Inspect history; this steering request will not be replayed.',
    );
  }
}
