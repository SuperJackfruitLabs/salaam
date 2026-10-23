import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SalaamService } from '../../src/service.js';
import { call } from '../../src/transport.js';
import { client } from '../acp-helpers.js';
import { ready, until } from '../helpers.js';
import { digest } from '../../src/protocol.js';

async function setup() {
  const base = realpathSync(mkdtempSync('/tmp/sal-ap-authority-'));
  const dir = join(base, 'workspace');
  mkdirSync(dir);
  const binding = {
    version: 1,
    organization_id: 'org_00000000000000000001',
    principal_id: 'prn_00000000000000000002',
    node_id: 'node_fixture',
    station_id: 'station_fixture',
    station_key: 'salaam:' + createHash('sha256').update(dir).digest('hex').slice(0, 16),
    occupancy_epoch: 3,
    hub_session_id: 'acps_fixture',
    workspace: dir,
    run: { source: 'superpipeline', id: 'run_fixture', epoch: 7 },
  };
  const config = join(base, 'pins.json');
  const { organization_id, node_id, station_key, workspace } = binding;
  writeFileSync(
    config,
    JSON.stringify({ version: 1, organization_id, node_id, station_key, workspace }),
    { mode: 0o600 },
  );
  const state = join(base, 'private-state');
  let service = await SalaamService.open({ stateDir: state, agentpodConfig: config });
  return {
    dir,
    state,
    binding,
    config,
    get service() {
      return service;
    },
    async reopen() {
      await service.close();
      service = await SalaamService.open({ stateDir: state, agentpodConfig: config });
    },
    async close() {
      await service.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('native grant windows use fresh exact-root wall and monotonic admission limits without extending review expiry', async () => {
  const f = await setup();
  try {
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'grant-window-admit',
      binding: f.binding,
    });
    const authority = f.service.agentpod!;
    const root = digest(f.binding);
    expect(() => authority.leaseWindow(admitted.session_id, root, 5000)).toThrowError(
      expect.objectContaining({ code: 'authority_expired' }),
    );
    await call(f.service.socket, '/v1/agentpod/renew', {
      request_id: 'grant-window-renew',
      binding: f.binding,
      lease_sequence: 1,
    });
    expect(authority.leaseWindow(admitted.session_id, root, 3000)).toBeLessThanOrEqual(3000);
    const update = f.service.store.db.prepare(
      'UPDATE agentpod_admissions SET expires_at=?,monotonic_deadline=? WHERE id=?',
    );
    // A wall-clock rollback must not extend work beyond the monotonic lease.
    update.run(Date.now() + 600000, performance.now() + 12000, admitted.admission_id);
    const monotonic = authority.leaseWindow(admitted.session_id, root, 90000);
    expect(monotonic).toBeGreaterThan(0);
    expect(monotonic).toBeLessThanOrEqual(12000);
    // Every read uses the actual current row, rather than a cached previous grant.
    update.run(Date.now() + 7000, performance.now() + 60000, admitted.admission_id);
    expect(authority.leaseWindow(admitted.session_id, root, 90000)).toBeLessThanOrEqual(7000);
    expect(() => authority.leaseWindow(admitted.session_id, 'f'.repeat(64), 5000)).toThrowError(
      expect.objectContaining({ code: 'authority_binding' }),
    );
    for (const invalid of [0, -1, 1.5, 90001, NaN, Infinity])
      expect(() => authority.leaseWindow(admitted.session_id, root, invalid)).toThrowError(
        expect.objectContaining({ code: 'invalid_authority_window' }),
      );
    f.service.store.db
      .prepare(
        'UPDATE agentpod_station_epochs SET occupancy_epoch=occupancy_epoch+1 WHERE station_id=?',
      )
      .run(f.binding.station_id);
    expect(() => authority.leaseWindow(admitted.session_id, root, 5000)).toThrowError(
      expect.objectContaining({ code: 'authority_binding' }),
    );
  } finally {
    await f.close();
  }
});

test('native grant windows reject expired, revoked and previous-daemon admissions', async () => {
  for (const fault of ['monotonic', 'wall', 'boot', 'revoked']) {
    const f = await setup();
    try {
      const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'admit',
        binding: f.binding,
      });
      await call(f.service.socket, '/v1/agentpod/renew', {
        request_id: 'renew',
        binding: f.binding,
        lease_sequence: 1,
      });
      const updates = {
        monotonic: 'monotonic_deadline=0',
        wall: 'expires_at=0',
        boot: "boot_id='old-daemon'",
        revoked: "state='revoked'",
      };
      f.service.store.db.exec(
        `UPDATE agentpod_admissions SET ${updates[fault as keyof typeof updates]}`,
      );
      expect(() =>
        f.service.agentpod!.leaseWindow(admitted.session_id, digest(f.binding), 5000),
      ).toThrowError(expect.objectContaining({ code: 'authority_expired' }));
    } finally {
      await f.close();
    }
  }
});

test('only a node-admitted, fresh bound ACP client can execute; detach and restart retain one session and prompt', async () => {
  const f = await setup();
  let a: ReturnType<typeof client> | undefined;
  try {
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'admit',
      binding: f.binding,
    });
    await expect(f.service.supervisor.start(admitted.session_id)).rejects.toThrow(
      /authority|lease/i,
    );
    const renew = { request_id: 'renew:1', binding: f.binding, lease_sequence: 1 };
    await call(f.service.socket, '/v1/agentpod/renew', renew);
    a = client(f.state, {
      SALAAM_AGENTPOD_ADMISSION: admitted.admission_id,
      SALAAM_AGENTPOD_TOKEN: admitted.token,
    });
    await a.initialize({ _meta: { 'salaam.dev/features': { promptReceipts: 1, updateIds: 1 } } });
    expect((await a.request('session/new', { cwd: f.dir, mcpServers: [] })).sessionId).toBe(
      admitted.session_id,
    );
    await ready(f.service, admitted.session_id);
    const logical = randomUUID();
    const params = {
      sessionId: admitted.session_id,
      prompt: [{ type: 'text', text: 'One admitted instruction' }],
      _meta: { 'salaam.dev/requestId': logical },
    };
    const result = await a.request('session/prompt', params);
    expect(
      a.messages.some(
        (m) =>
          m.params?.update?._meta?.['salaam.dev/promptReceipt']?.requestId === logical &&
          m.params.update._meta['salaam.dev/promptReceipt'].attemptId ===
            result._meta['salaam.dev/attemptId'],
      ),
    ).toBe(true);
    await a.close();
    const legacy = client(f.state, {
      SALAAM_AGENTPOD_ADMISSION: admitted.admission_id,
      SALAAM_AGENTPOD_TOKEN: admitted.token,
    });
    try {
      await legacy.initialize();
      await legacy.request('session/load', {
        sessionId: admitted.session_id,
        cwd: f.dir,
        mcpServers: [],
      });
      expect(
        legacy.messages.some((m) => m.params?.update?._meta?.['salaam.dev/promptReceipt']),
      ).toBe(false);
    } finally {
      await legacy.close();
    }
    await f.reopen();
    await expect(f.service.supervisor.start(admitted.session_id)).rejects.toThrow(
      /authority|lease/i,
    );
    // A replayed old renewal cannot validate a new daemon boot or extend its deadline.
    await call(f.service.socket, '/v1/agentpod/renew', renew);
    await expect(f.service.supervisor.start(admitted.session_id)).rejects.toThrow(
      /authority|lease/i,
    );
    await call(f.service.socket, '/v1/agentpod/renew', {
      ...renew,
      request_id: 'renew:2',
      lease_sequence: 2,
    });
    a = client(f.state, {
      SALAAM_AGENTPOD_ADMISSION: admitted.admission_id,
      SALAAM_AGENTPOD_TOKEN: admitted.token,
    });
    await a.initialize({ _meta: { 'salaam.dev/features': { promptReceipts: 1, updateIds: 1 } } });
    await a.request('session/new', { cwd: f.dir, mcpServers: [] });
    const repeated = await a.request('session/prompt', params);
    expect(repeated._meta['salaam.dev/attemptId']).toBe(result._meta['salaam.dev/attemptId']);
    expect(f.service.store.snapshot(admitted.session_id).attempts).toHaveLength(1);
    await expect(
      call(f.service.socket, '/v1/agentpod/renew', {
        ...renew,
        request_id: 'wrong-epoch',
        lease_sequence: 3,
        binding: { ...f.binding, run: { ...f.binding.run, epoch: 6 } },
      }),
    ).rejects.toThrow(/binding|authority/i);
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'foreign',
        binding: {
          ...f.binding,
          organization_id: 'org_00000000000000000009',
          hub_session_id: 'foreign',
        },
      }),
    ).rejects.toThrow(/organization|binding/i);
    await expect(
      a.request('session/load', {
        sessionId: f.service.store.create(f.dir, 'other').id,
        cwd: f.dir,
        mcpServers: [],
      }),
    ).rejects.toThrow(/bound|admission/i);
  } finally {
    await a?.close();
    await f.close();
  }
});

test('revocation overtaking admission saves a tombstone; replay and fresh renewals cannot resurrect it or journal its credential', async () => {
  const f = await setup();
  try {
    const stopped = await call<any>(f.service.socket, '/v1/agentpod/revoke', {
      request_id: 'stop-before-admit',
      binding: f.binding,
      reason: 'Authority withdrawn before dispatch',
    });
    expect(stopped).toMatchObject({
      revoked: true,
      owned_execution_stopped: true,
      authorized: false,
    });
    const late = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'late-admit',
      binding: f.binding,
    });
    expect(late.session_id).toBe(stopped.session_id);
    expect(late.authorized).toBe(false);
    await expect(
      call(f.service.socket, '/v1/agentpod/renew', {
        request_id: 'late-renew',
        binding: f.binding,
        lease_sequence: 1,
      }),
    ).rejects.toThrow(/expired|revoked/i);
    await expect(
      call(f.service.socket, '/v1/agentpod/attach', {
        admission_id: late.admission_id,
        token: late.token,
      }),
    ).rejects.toThrow(/authority|revoked/i);
    expect(
      f.service.store.db
        .prepare('SELECT response FROM requests')
        .all()
        .every((r) => !String(r.response).includes(late.token)),
    ).toBe(true);
    expect(f.service.store.db.prepare('SELECT 1 FROM workers').get()).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('a replacement cannot acquire an old run epoch, changed occupant or still-unconfirmed station execution', async () => {
  const f = await setup();
  try {
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'admit',
      binding: f.binding,
    });
    await call(f.service.socket, '/v1/agentpod/renew', {
      request_id: 'renew:1',
      binding: f.binding,
      lease_sequence: 1,
    });
    await f.service.supervisor.start(admitted.session_id);
    await ready(f.service, admitted.session_id);
    const next = {
      ...f.binding,
      hub_session_id: 'next',
      run: { ...f.binding.run, id: 'run_next' },
    };
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', { request_id: 'while-active', binding: next }),
    ).rejects.toThrow(/revoked|stopped|reconciled/i);
    const fenced = f.service.agentpod!.revoke(f.binding, 'revoke', 'Work authority ended');
    expect(fenced.revoked).toBe(true);
    expect(fenced.owned_execution_stopped).toBe(false);
    expect(() => f.service.agentpod!.admit(next, 'unconfirmed')).toThrow(/stopped|reconciled/i);
    await f.service.supervisor.stopSession(admitted.session_id);
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'duplicate-run',
        binding: { ...next, run: f.binding.run },
      }),
    ).rejects.toThrow(/already.*execution|original admission/i);
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'changed-occupant',
        binding: { ...next, principal_id: 'prn_00000000000000000009' },
      }),
    ).rejects.toThrow(/occupancy.*stale/i);
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'older-run-epoch',
        binding: { ...next, run: { ...f.binding.run, epoch: f.binding.run.epoch - 1 } },
      }),
    ).rejects.toThrow(/run.*epoch.*stale/i);
    const replacement = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'replacement',
      binding: { ...next, occupancy_epoch: 4, principal_id: 'prn_00000000000000000009' },
    });
    expect(replacement.session_id).not.toBe(admitted.session_id);
    expect(f.service.store.snapshot(replacement.session_id).messages).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('the authority deadline denies grants before the expiry sweep; the dedicated daemon rejects unbound ACP and coding profiles', async () => {
  const f = await setup();
  let a: ReturnType<typeof client> | undefined;
  try {
    a = client(f.state);
    await a.initialize({ _meta: { 'salaam.dev/features': { promptReceipts: 1, updateIds: 1 } } });
    await expect(
      a.request('session/new', {
        cwd: f.dir,
        mcpServers: [],
        _meta: { 'agentpod/principal': f.binding.principal_id },
      }),
    ).rejects.toThrow(/admission|unbound/i);
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'admit',
      binding: f.binding,
    });
    await call(f.service.socket, '/v1/agentpod/renew', {
      request_id: 'renew',
      binding: f.binding,
      lease_sequence: 1,
    });
    await f.service.supervisor.start(admitted.session_id);
    await ready(f.service, admitted.session_id);
    f.service.store.db
      .prepare('UPDATE agentpod_admissions SET monotonic_deadline=? WHERE id=?')
      .run(performance.now() - 1, admitted.admission_id);
    expect(() =>
      f.service.store.usage.admit(admitted.session_id, undefined, 'too-late', 'proof', 'proof'),
    ).toThrow(/lease|authority/i);
    await until(() => f.service.store.execution.revocation(admitted.session_id), Boolean);
    await until(
      () => f.service.store.session(admitted.session_id).state,
      (s) => s === 'exited' || s === 'unhealthy',
    );
    await expect(
      call(f.service.socket, '/v1/agentpod/renew', {
        request_id: 'renew-again',
        binding: f.binding,
        lease_sequence: 2,
      }),
    ).rejects.toThrow(/expired|revoked/i);
    expect(
      f.service.store.events(admitted.session_id, 0).filter((e) => e.kind === 'model.admitted'),
    ).toHaveLength(0);
    await expect(
      SalaamService.open({
        stateDir: join(f.state, 'bad-profile'),
        agentpodConfig: f.config,
        codingRoot: f.dir,
      }),
    ).rejects.toThrow(/does not enable/i);
  } finally {
    await a?.close();
    await f.close();
  }
});

test('corrupted durable binding or digest denies readiness and fresh model grants', async () => {
  const f = await setup();
  try {
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'admit',
      binding: f.binding,
    });
    await call(f.service.socket, '/v1/agentpod/renew', {
      request_id: 'renew',
      binding: f.binding,
      lease_sequence: 1,
    });
    const saved = f.service.store.db
      .prepare('SELECT binding,digest FROM agentpod_admissions WHERE id=?')
      .get(admitted.admission_id)!;
    f.service.store.db
      .prepare('UPDATE agentpod_admissions SET digest=? WHERE id=?')
      .run('corrupt', admitted.admission_id);
    await expect(f.service.supervisor.start(admitted.session_id)).rejects.toThrow(
      /integrity|binding/i,
    );
    expect(() =>
      f.service.store.usage.admit(
        admitted.session_id,
        undefined,
        'corrupt-digest',
        'proof',
        'proof',
      ),
    ).toThrow(/integrity|binding/i);
    f.service.store.db
      .prepare('UPDATE agentpod_admissions SET digest=?,binding=? WHERE id=?')
      .run(
        String(saved.digest),
        JSON.stringify({ ...f.binding, principal_id: 'prn_00000000000000000009' }),
        admitted.admission_id,
      );
    expect(() =>
      f.service.store.usage.admit(
        admitted.session_id,
        undefined,
        'corrupt-binding',
        'proof',
        'proof',
      ),
    ).toThrow(/integrity|binding/i);
    f.service.store.db
      .prepare('UPDATE agentpod_admissions SET binding=? WHERE id=?')
      .run(String(saved.binding), admitted.admission_id);
    f.service.store.db
      .prepare('UPDATE agentpod_station_epochs SET occupancy_epoch=occupancy_epoch+1')
      .run();
    expect(() =>
      f.service.store.usage.admit(
        admitted.session_id,
        undefined,
        'stale-generation',
        'proof',
        'proof',
      ),
    ).toThrow(/integrity|generation/i);
    expect(
      f.service.store.events(admitted.session_id, 0).filter((e) => e.kind === 'model.admitted'),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('strict work is private-owner only and refuses missing protected verification backend', async () => {
  const f = await setup();
  try {
    const input = { instructions: 'Inspect', references: [], incoming_handoff: null };
    const plan = f.service.taskWork.parse({
      objective: 'Inspect',
      constraints: [],
      steps: [
        { key: 'inspect', title: 'Inspect', instruction: 'Inspect', depends_on: [], checks: [] },
      ],
      acceptance: [],
      deliverables: [],
    });
    const payload = {
      admission: {
        version: 1,
        request_id: randomUUID(),
        binding: f.binding,
        work: {
          board_id: 'brd_Aa0Bb1',
          card_id: 'card_Aa0Bb1',
          stage_key: 'implement',
          input_digest: digest(input),
          plan_digest: digest(plan),
        },
      },
      input,
      plan,
    };
    expect(await call(f.service.socket, '/v1/agentpod/work-capability', {})).toEqual({
      version: 1,
      enabled: false,
    });
    await expect(
      call(f.service.bridgeSocket, '/v1/agentpod/work-capability', {}),
    ).rejects.toThrow();
    await expect(call(f.service.bridgeSocket, '/v1/agentpod/work-admit', payload)).rejects.toThrow(
      'Bridge route not found',
    );
    await expect(call(f.service.socket, '/v1/agentpod/work-admit', payload)).rejects.toThrow(
      'protected station',
    );
    const settlement = {
      binding: f.binding,
      request_id: randomUUID(),
      work_request_id: randomUUID(),
      producer_terminal_digest: 'a'.repeat(64),
    };
    await expect(
      call(f.service.bridgeSocket, '/v1/agentpod/work-settle', settlement),
    ).rejects.toThrow('Bridge route not found');
    await expect(call(f.service.socket, '/v1/agentpod/work-settle', settlement)).rejects.toThrow(
      'not enabled',
    );
    await expect(
      call(f.service.bridgeSocket, '/v1/agentpod/work-expire', {
        ...settlement,
        decision_request_id: randomUUID(),
      }),
    ).rejects.toThrow('Bridge route not found');
    await expect(
      call(f.service.bridgeSocket, '/v1/agentpod/work-fail', settlement),
    ).rejects.toThrow('Bridge route not found');
    await expect(
      call(f.service.bridgeSocket, '/v1/agentpod/work-abandon', settlement),
    ).rejects.toThrow('Bridge route not found');
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM durable_tasks').get()!.n).toBe(0);
  } finally {
    await f.close();
  }
});

// Reviewed-backend presence is a controlled negotiation double here; actual
// protected station progression is covered by the separate Linux acceptance.
test('authenticated strict ACP cold-start releases only its bootstrap control and stays an observer', async () => {
  const f = await setup();
  Object.assign(f.service, { agentpodWorkProgression: true, agentpodWork: {} });
  let a: ReturnType<typeof client> | undefined;
  try {
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      binding: f.binding,
      request_id: 'strict-admit',
    });
    await call(f.service.socket, '/v1/agentpod/renew', {
      binding: f.binding,
      request_id: 'strict-renew',
      lease_sequence: 1,
    });
    const attached = await call<any>(f.service.socket, '/v1/agentpod/attach', {
      admission_id: admitted.admission_id,
      token: admitted.token,
    });
    expect(attached.work_control).toEqual({ version: 1, owner: 'superpipeline' });
    a = client(f.state, {
      SALAAM_AGENTPOD_ADMISSION: admitted.admission_id,
      SALAAM_AGENTPOD_TOKEN: admitted.token,
    });
    await a.initialize();
    await a.request('session/new', { cwd: f.dir, mcpServers: [] });
    await ready(f.service, admitted.session_id);
    const released = f.service.store.controlView(admitted.session_id);
    expect(released.expires_at).toBe(0);
    expect(released.client_id).toBe(null);
    await expect(
      a.request('session/prompt', {
        sessionId: admitted.session_id,
        prompt: [{ type: 'text', text: 'Bypass board owner' }],
      }),
    ).rejects.toThrow();
    await expect(a.request('session/cancel', { sessionId: admitted.session_id })).rejects.toThrow();
    // Cross the adapter's old renewal interval: no late renewal may resurrect its lease.
    await new Promise((r) => setTimeout(r, 5200));
    expect(f.service.store.controlView(admitted.session_id)).toEqual(released);
    expect(f.service.store.snapshot(admitted.session_id).attempts).toHaveLength(0);
    const other = f.service.store.control(
      admitted.session_id,
      'other-acquire',
      'other-terminal',
      'acquire',
      released.epoch,
    );
    await a.close();
    a = undefined;
    expect(f.service.store.controlView(admitted.session_id).client_id).toBe(other.client_id);
  } finally {
    await a?.close();
    await f.close();
  }
});
test('strict ACP bootstrap cannot take over a competing controller', async () => {
  const f = await setup();
  Object.assign(f.service, { agentpodWorkProgression: true, agentpodWork: {} });
  let a: ReturnType<typeof client> | undefined;
  try {
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      binding: f.binding,
      request_id: 'strict-competing',
    });
    await call(f.service.socket, '/v1/agentpod/renew', {
      binding: f.binding,
      request_id: 'strict-competing-renew',
      lease_sequence: 1,
    });
    const lease = f.service.store.control(
      admitted.session_id,
      'competing-acquire',
      'other-terminal',
      'acquire',
      0,
    );
    a = client(f.state, {
      SALAAM_AGENTPOD_ADMISSION: admitted.admission_id,
      SALAAM_AGENTPOD_TOKEN: admitted.token,
    });
    await a.initialize();
    await expect(
      a.request('session/new', {
        cwd: f.dir,
        mcpServers: [],
        _meta: { 'salaam.dev/takeover': true },
      }),
    ).rejects.toThrow();
    expect(f.service.store.controlView(admitted.session_id).client_id).toBe(lease.client_id);
    expect(f.service.store.snapshot(admitted.session_id).attempts).toHaveLength(0);
  } finally {
    await a?.close();
    await f.close();
  }
});

test('a revoked interactive conversation continues under a fresh admission, once, with its history', async () => {
  const f = await setup();
  let a: ReturnType<typeof client> | undefined;
  try {
    const first = {
      ...f.binding,
      hub_session_id: 'acps_first',
      run: { source: 'agentpod', id: 'acps_first', epoch: 1 },
    };
    const admitted = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'admit:first',
      binding: first,
    });
    expect(admitted.continued_from).toBeNull();
    await call(f.service.socket, '/v1/agentpod/renew', {
      request_id: 'renew:first',
      binding: first,
      lease_sequence: 1,
    });
    a = client(f.state, {
      SALAAM_AGENTPOD_ADMISSION: admitted.admission_id,
      SALAAM_AGENTPOD_TOKEN: admitted.token,
    });
    await a.initialize({ _meta: { 'salaam.dev/features': { promptReceipts: 1, updateIds: 1 } } });
    await a.request('session/new', { cwd: f.dir, mcpServers: [] });
    await ready(f.service, admitted.session_id);
    await a.request('session/prompt', {
      sessionId: admitted.session_id,
      prompt: [{ type: 'text', text: 'Remember the word mango' }],
      _meta: { 'salaam.dev/requestId': randomUUID() },
    });
    await a.close();
    a = undefined;
    const history = f.service.store.snapshot(admitted.session_id).messages;
    expect(history.length).toBeGreaterThan(0);
    const second = {
      ...first,
      hub_session_id: 'acps_second',
      run: { ...first.run, id: 'acps_second' },
    };
    // Live authority cannot be continued: the old execution must be revoked and stopped first.
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'admit:early',
        binding: second,
        continue_from: 'acps_first',
      }),
    ).rejects.toThrow(/revoked|stopped|reconciled/i);
    f.service.agentpod!.revoke(first, 'revoke:first', 'Idle');
    await f.service.supervisor.stopSession(admitted.session_id);
    // Board work never continues an interactive conversation.
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'admit:board',
        binding: { ...second, run: { source: 'superpipeline', id: 'run_x', epoch: 1 } },
        continue_from: 'acps_first',
      }),
    ).rejects.toThrow(/interactive/i);
    const resumed = await call<any>(f.service.socket, '/v1/agentpod/admit', {
      request_id: 'admit:second',
      binding: second,
      continue_from: 'acps_first',
    });
    expect(resumed.session_id).not.toBe(admitted.session_id);
    expect(resumed.admission_id).not.toBe(admitted.admission_id);
    expect(resumed.continued_from).toBe('acps_first');
    expect(resumed.revoked).toBe(false);
    expect(f.service.store.snapshot(resumed.session_id).messages).toEqual(history);
    // The old execution stays revoked: continuing never resurrects its authority.
    expect(f.service.agentpod!.inspect(first).revoked).toBe(true);
    await call(f.service.socket, '/v1/agentpod/renew', {
      request_id: 'renew:second',
      binding: second,
      lease_sequence: 1,
    });
    expect(f.service.agentpod!.inspect(second).authorized).toBe(true);
    f.service.agentpod!.revoke(second, 'revoke:second', 'Done');
    const third = {
      ...first,
      hub_session_id: 'acps_third',
      run: { ...first.run, id: 'acps_third' },
    };
    await expect(
      call(f.service.socket, '/v1/agentpod/admit', {
        request_id: 'admit:third',
        binding: third,
        continue_from: 'acps_first',
      }),
    ).rejects.toThrow(/already continued/i);
  } finally {
    await a?.close();
    await f.close();
  }
});
