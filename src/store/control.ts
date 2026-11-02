// Controller leases: which terminal controls a session, and the checks every controlled request makes.
import { randomBytes } from 'node:crypto';
import {
  ServiceError,
  textDigest,
  type Controller,
  type ControlLease,
  type ControlView,
} from '../core/index.js';
import type { Journal } from './journal.js';

export interface ControlStore extends Journal {
  controlView(id: string): ControlView;
  authorizeControl(id: string, controller: Controller): void;
}

export function controlView(store: Journal, id: string): ControlView {
  store.session(id);
  return (
    (store.db
      .prepare('SELECT client_id,epoch,expires_at FROM controls WHERE session_id=?')
      .get(id) as unknown as ControlView | undefined) ?? {
      client_id: null,
      epoch: 0,
      expires_at: 0,
    }
  );
}
export function authorizeControl(store: Journal, id: string, controller: Controller): void {
  const row = store.db
    .prepare('SELECT client_id,token_hash,expires_at FROM controls WHERE session_id=?')
    .get(id) as { client_id: string; token_hash: string; expires_at: number } | undefined;
  if (
    !row ||
    row.client_id !== controller.client_id ||
    row.token_hash !== textDigest(controller.token) ||
    row.expires_at <= Date.now()
  )
    throw new ServiceError('control_required', 'A current controller lease is required');
}
export function control(
  store: ControlStore,
  id: string,
  requestId: string,
  client: string,
  action: 'acquire' | 'renew' | 'release' | 'takeover',
  expectedEpoch: number,
  token?: string,
  ttl = 15000,
): ControlLease {
  return store.request(
    'local-operator',
    requestId,
    { kind: 'control', session: id, client, action, expectedEpoch },
    () => {
      const old = store.controlView(id);
      if (old.epoch !== expectedEpoch)
        throw new ServiceError('control_conflict', 'Controller epoch changed');
      if (action === 'renew' || action === 'release')
        store.authorizeControl(id, { client_id: client, token: token ?? '' });
      if (action === 'acquire' && old.expires_at > Date.now())
        throw new ServiceError('control_busy', 'Another terminal controls this session');
      const epoch = action === 'renew' ? old.epoch : old.epoch + 1;
      const nextToken = action === 'renew' ? token! : randomBytes(32).toString('hex');
      const expires = action === 'release' ? 0 : Date.now() + ttl;
      store.db
        .prepare(
          `INSERT INTO controls VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        client_id=excluded.client_id,token_hash=excluded.token_hash,epoch=excluded.epoch,expires_at=excluded.expires_at`,
        )
        .run(id, action === 'release' ? null : client, textDigest(nextToken), epoch, expires);
      store.event(
        id,
        `control.${action}`,
        { client_id: action === 'release' ? null : client, epoch, expires_at: expires },
        requestId,
      );
      return {
        client_id: action === 'release' ? null : client,
        epoch,
        token: nextToken,
        expires_at: expires,
      };
    },
  );
}
