import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mcpServiceFixture } from '../mcp-service-helpers.js';
import { ready, control, until } from '../helpers.js';
import { ToolkitAdmission, ToolkitCleanupAdmission } from '../../src/toolkit-admission.js';
import { ToolkitCalls } from '../../src/toolkit-calls.js';
import { digest } from '../../src/protocol.js';
import { call } from '../../src/transport.js';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
async function fixture(read = false) {
  const f = await mcpServiceFixture();
  await f.renew();
  await f.assign();
  await f.service.supervisor.start(f.admitted.session_id);
  await ready(f.service, f.admitted.session_id);
  const session = f.admitted.session_id,
    actor = await control(f.service, session, true);
  const target = randomUUID();
  const work = f.service.store.accept(
    session,
    target,
    f.service.store.session(session).revision,
    '[review] hold actual worker while testing private callback',
    actor,
  );
  await until(() => f.service.store.approvals(session).some((a) => a.state === 'pending'), Boolean);
  const binary = join(f.state, 'resource-peer'),
    policy = join(f.state, 'native-policy'),
    pass = join(f.state, 'native-pass'),
    store = join(f.state, 'native-store'),
    state = join(f.state, 'native-state');
  mkdirSync(store, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  // A protocol/process fixture only: the separate compiled Toolkit rehearsal
  // verifies the actual producer. This peer never executes any native effect.
  writeFileSync(
    binary,
    `#!${realpathSync(process.execPath)}
import readline from 'node:readline';import http from 'node:http';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
if(process.argv[2]==='managed-control-v1'){
 const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{
  const body=Buffer.concat(chunks),c=JSON.parse(body),m=JSON.parse(readFileSync(process.argv[4],'utf8'));
  writeFileSync(join(process.env.HOME,'control-seen.json'),body);
  const send=()=>{
   const req=http.request({socketPath:m.owner_socket,path:'/managed-toolkit/v1/control',method:'POST',headers:{authorization:'Bearer '+m.owner_key,'content-type':'application/json'}},res=>{
    const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{
     const reply=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200||reply.decision!=='allowed')return process.exit(7);
     const result={version:1,control_digest:createHash('sha256').update(body).digest('hex'),root_revoked:c.action==='revoke'};
     if(c.action!=='revoke')result.receipt={id:createHash('sha256').update(JSON.stringify(['stk.managed-mcp.v1',c.root_digest,c.invocation_id])).digest('hex'),request_digest:c.request_digest,state:'outcome_unknown'};
     process.stdout.write(JSON.stringify(result));
    });
   });req.on('error',()=>process.exit(8));req.end(body);
  };
  const hold=join(process.env.HOME,'control-hold');
  if(existsSync(hold)){const timer=setInterval(()=>{if(!existsSync(hold)){clearInterval(timer);send();}},20);}else send();
 });
}else{
 readline.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'resource-fixture',version:'1'}}})+'\\n');});setInterval(()=>{},1000);
}
`,
    { mode: 0o700 },
  );
  writeFileSync(policy, 'services:\n  github: {}\n', { mode: 0o600 });
  writeFileSync(pass, 'synthetic-only\n', { mode: 0o600 });
  const key = randomBytes(32).toString('hex'),
    profileDigest = digest({
      version: 1,
      kind: 'stk-native-managed-v1',
      protocol: '2025-06-18',
      policy_sha256: sha(policy),
      profile: '',
    });
  const manifest = {
    version: 1,
    root_digest: digest(f.binding),
    profile_digest: profileDigest,
    workspace: f.workspace,
    policy_path: policy,
    policy_sha256: sha(policy),
    profile: '',
    store_dir: store,
    passphrase_file: pass,
    state_dir: state,
    owner_socket: f.service.socket,
    owner_key: key,
  };
  const manifestPath = join(f.state, 'native-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const profile = {
    version: 1,
    kind: 'stk-native-managed-v1',
    private_dir: f.state,
    credential_delegation: {
      organization_id: f.binding.organization_id,
      principal_id: f.binding.principal_id,
      binding_digest: digest(f.binding),
    },
    executable: { path: binary, sha256: sha(binary) },
    manifest: { path: manifestPath, sha256: sha(manifestPath) },
    passphrase_sha256: sha(pass),
    limits: { request_bytes: 65536, response_bytes: 131072, stderr_bytes: 4096, timeout_ms: 3000 },
  };
  const profilePath = join(f.state, 'native-profile.json');
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const admission = new ToolkitAdmission(profilePath, sha(profilePath)),
    resources = f.service.toolkitResources,
    resourceId = 'actual-owner-resource';
  const transport = admission.transport(resources, session, resourceId);
  const calls = new ToolkitCalls(f.service.store, f.service.managed, {
    authority: f.service.agentpod!,
    resources,
    assertActive: (s, e, a) => f.service.supervisor.assertActive(s, e, a),
    action: () => ({
      kind: read ? 'read' : 'write',
      policy: read ? 'agent' : 'approval',
      digest: 'd'.repeat(64),
    }),
  });
  f.service.toolkitOwners.register(resourceId, calls, admission);
  const client = new Client({ name: 'owner-proof', version: '1' }, { capabilities: {} });
  const request = {
    version: 1 as const,
    root_digest: digest(f.binding),
    profile_digest: profileDigest,
    invocation_id: 'owner-invocation',
    service: 'github',
    action: read ? 'get_user' : 'create_issue',
    args: read ? {} : { title: 'synthetic owner test' },
    approval: !read,
    expires_at_ms: Date.now() + 60000,
  };
  const endpoint = '/managed-toolkit/v1/verify';
  const verify = (phase: string, body: unknown = request, token = key) =>
    call<any>(f.service.socket, endpoint, { version: 1, phase, request: body }, token);
  return {
    f,
    session,
    work,
    actor,
    target,
    resourceId,
    resources,
    calls,
    request,
    verify,
    client,
    transport,
    admission,
    key,
    manifestPath,
    profilePath,
    prepare: () =>
      calls.prepare(
        session,
        f.service.store.session(session).epoch,
        work.attempt_id,
        'owner-tool',
        resourceId,
        request,
      ),
    async close() {
      calls.close();
      await client.close();
      await f.close();
    },
  };
}

test('actual private service callback requires registered PID, actual worker and exact human decision before consuming one grant', async () => {
  const f = await fixture();
  try {
    await expect(f.verify('admit')).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    await f.client.connect(f.transport);
    const call = f.prepare();
    f.calls.deliver(call.id);
    expect(await f.verify('review')).toMatchObject({ decision: 'pending' });
    expect(await f.verify('admit')).toMatchObject({ decision: 'denied' });
    const op = f.f.service.managed.operation(call.operation_id!),
      a = f.f.service.managed.forOperation(op.id);
    f.f.service.managed.decide(a.id, 'native-approve', a.revision, op.operation_digest, 'approve');
    expect(await f.verify('review')).toMatchObject({
      decision: 'allowed',
      decision_id: expect.any(String),
    });
    expect(await f.verify('admit')).toMatchObject({
      decision: 'allowed',
      authority_for_ms: expect.any(Number),
    });
    expect(f.f.service.managed.operation(op.id).state).toBe('prepared');
    expect(await f.verify('dispatch')).toMatchObject({ decision: 'allowed', send_within_ms: 1000 });
    expect(await f.verify('dispatch')).toMatchObject({ decision: 'denied' });
    expect(f.f.service.managed.operation(op.id).state).toBe('dispatching');
    expect(JSON.stringify(f.f.service.store.events(f.session, 0))).not.toContain(f.key);
    expect(f.f.sent).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('cancelling a completed instruction leaves the actual later worker and its native broker running', async () => {
  const f = await fixture(true);
  try {
    await f.client.connect(f.transport);
    const first = f.prepare();
    f.calls.deliver(first.id);
    await f.verify('dispatch');
    f.calls.record(first.id, f.resourceId, {
      id: first.id,
      request_digest: first.request_digest,
      state: 'returned',
      result: '{"read":"protocol-only"}',
    });
    const approval = f.f.service.store.approvals(f.session).find((a) => a.state === 'pending')!,
      op = f.f.service.managed.operation(approval.operation_id);
    f.f.service.managed.decide(
      approval.id,
      'complete-original-review',
      approval.revision,
      op.operation_digest,
      'approve',
    );
    await until(
      () => f.f.service.store.attempt(f.work.attempt_id).state,
      (s) => s === 'completed',
    );
    const next = f.f.service.store.accept(
      f.session,
      randomUUID(),
      f.f.service.store.session(f.session).revision,
      '[review] later actual prompt',
      f.actor,
    );
    await until(
      () =>
        f.f.service.store
          .approvals(f.session)
          .some(
            (a) =>
              a.state === 'pending' &&
              f.f.service.managed.operation(a.operation_id).attempt_id === next.attempt_id,
          ),
      Boolean,
    );
    const second = f.calls.prepare(
      f.session,
      f.f.service.store.session(f.session).epoch,
      next.attempt_id,
      'later-native-tool',
      f.resourceId,
      { ...f.request, invocation_id: 'later-native-invocation' },
    );
    f.calls.deliver(second.id);
    const receipt = f.f.service.cancellations.begin(f.session, randomUUID(), f.target, f.actor);
    expect(receipt.state).toBe('confirmed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.f.service.store.attempt(next.attempt_id).state).toBe('running');
    expect(f.resources.get(f.resourceId).state).toBe('running');
    expect(f.calls.get(second.id).state).toBe('delivered');
    f.resources.assertLive(f.resourceId);
  } finally {
    await f.close();
  }
});

test('actual owner endpoint rejects another key, changed request and private configuration drift', async () => {
  const f = await fixture();
  try {
    await f.client.connect(f.transport);
    const call = f.prepare();
    f.calls.deliver(call.id);
    for (const [body, key] of [
      [f.request, '0'.repeat(64)],
      [{ ...f.request, args: { title: 'changed' } }, f.key],
      [{ ...f.request, root_digest: 'e'.repeat(64) }, f.key],
    ] as const) {
      await expect(f.verify('review', body, key)).rejects.toThrowError(
        expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
      );
    }
    writeFileSync(f.manifestPath, readFileSync(f.manifestPath, 'utf8') + ' ');
    await expect(f.verify('review')).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    expect(f.calls.get(call.id).state).toBe('delivered');
    expect(f.f.service.managed.operation(call.operation_id!).state).toBe('prepared');
  } finally {
    await f.close();
  }
});

test('a stopped predecessor key cannot register a replacement process and no owner is silently adopted after daemon reopen', async () => {
  const f = await fixture();
  try {
    await f.client.connect(f.transport);
    await f.client.close();
    await f.resources.stop(f.resourceId);
    f.admission.transport(f.resources, f.session, 'replacement-resource');
    expect(() =>
      f.f.service.toolkitOwners.register('replacement-resource', f.calls, f.admission),
    ).toThrowError(expect.objectContaining({ code: 'toolkit_owner_unavailable' }));
    await f.resources.stop('replacement-resource');
    f.calls.close();
    await f.f.reopen();
    await expect(f.verify('review')).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    expect(f.f.service.store.db.prepare('SELECT count(*) AS n FROM toolkit_owners').get()!.n).toBe(
      1,
    );
  } finally {
    await f.close();
  }
});

test('actual service admits a fresh broker key after observed stop without rewriting the reviewed host profile', async () => {
  const f = await fixture(true);
  let replacement: Client | undefined;
  try {
    const profileHash = sha(f.profilePath),
      templateHash = sha(f.manifestPath);
    await f.client.connect(f.transport);
    const first = f.prepare();
    f.calls.deliver(first.id);
    expect(await f.verify('dispatch')).toMatchObject({ decision: 'allowed' });
    f.calls.record(first.id, f.resourceId, {
      id: first.id,
      request_digest: first.request_digest,
      state: 'returned',
      result: '{"read":"protocol-only"}',
    });
    const binding = f.f.service.agentpod!.binding(f.session),
      child = f.admission.materialize(binding),
      resourceId = 'fresh-owner-resource';
    // Materialization itself does not stop, replace or adopt an actual process.
    expect(() => child.transport(f.resources, f.session, resourceId)).toThrowError(
      expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }),
    );
    await f.client.close();
    await f.resources.stop(f.resourceId);
    expect(f.resources.stopProof(f.resourceId).method).toBe('observed_exit');
    const transport = child.transport(f.resources, f.session, resourceId);
    f.f.service.toolkitOwners.register(resourceId, f.calls, child);
    replacement = new Client({ name: 'fresh-owner-proof', version: '1' }, { capabilities: {} });
    await replacement.connect(transport);
    const manifest = JSON.parse(readFileSync(child.launch(binding).launch.args[2]!, 'utf8')),
      request = { ...f.request, invocation_id: 'fresh-process-invocation' },
      next = f.calls.prepare(
        f.session,
        f.f.service.store.session(f.session).epoch,
        f.work.attempt_id,
        'fresh-native-tool',
        resourceId,
        request,
      );
    f.calls.deliver(next.id);
    await expect(
      call(
        f.f.service.socket,
        '/managed-toolkit/v1/verify',
        { version: 1, phase: 'dispatch', request },
        f.key,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'toolkit_owner_unavailable' }));
    expect(
      await call(
        f.f.service.socket,
        '/managed-toolkit/v1/verify',
        { version: 1, phase: 'dispatch', request },
        manifest.owner_key,
      ),
    ).toMatchObject({ decision: 'allowed' });
    expect(sha(f.profilePath)).toBe(profileHash);
    expect(sha(f.manifestPath)).toBe(templateHash);
    // Even a running child's fresh key cannot outlive the original host pins.
    writeFileSync(f.profilePath, readFileSync(f.profilePath, 'utf8') + ' ');
    await expect(
      call(
        f.f.service.socket,
        '/managed-toolkit/v1/verify',
        { version: 1, phase: 'admit', request },
        manifest.owner_key,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'toolkit_owner_unavailable' }));
    expect(JSON.stringify(f.f.service.store.events(f.session, 0))).not.toContain(
      manifest.owner_key,
    );
    expect(f.f.sent).toHaveLength(0);
  } finally {
    await replacement?.close();
    await f.close();
  }
});

test('separate cleanup admission needs the actual predecessor stop and survives revoked execution, credential removal and daemon recovery', async () => {
  const f = await fixture(true);
  try {
    const snapshot = f.admission.cleanup(f.resources, f.resourceId),
      reference = snapshot.reference;
    expect(() => snapshot.materialize(f.resources)).toThrowError(
      expect.objectContaining({ code: 'toolkit_profile_changed' }),
    );
    await f.client.connect(f.transport);
    expect(() => snapshot.materialize(f.resources)).toThrowError(
      expect.objectContaining({ code: 'toolkit_profile_changed' }),
    );
    await f.client.close();
    await f.resources.stop(f.resourceId);
    const binding = f.f.service.agentpod!.binding(f.session);
    f.f.service.agentpod!.revoke(binding, randomUUID(), 'cleanup-role proof');
    await f.f.service.supervisor.stopSession(f.session);
    await f.f.reopen();
    // Simulate rotation/removal after the original private cleanup snapshot.
    for (const name of [
      'native-policy',
      'native-pass',
      'native-store',
      'native-manifest.json',
      'native-profile.json',
    ])
      rmSync(join(f.f.state, name), { recursive: true });
    rmSync(f.f.workspace, { recursive: true });
    const resources = f.f.service.toolkitResources,
      restored = new ToolkitCleanupAdmission(reference.path, reference.sha256),
      first = restored.materialize(resources),
      second = restored.materialize(resources),
      admitted = first.launch(resources),
      manifest = JSON.parse(readFileSync(admitted.launch.args[2]!, 'utf8'));
    expect(() => f.f.service.agentpod!.binding(f.session)).toThrowError(
      expect.objectContaining({ code: 'session_revoked' }),
    );
    expect(admitted).toMatchObject({
      predecessor_id: f.resourceId,
      stop_proof_digest: digest(resources.stopProof(f.resourceId)),
      owner_key_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(admitted.launch.args[0]).toBe('managed-control-v1');
    expect(admitted.launch.cwd).toBe(f.f.state);
    expect(admitted.launch.env).toEqual({ HOME: f.f.state });
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'version',
        'root_digest',
        'profile_digest',
        'workspace',
        'state_dir',
        'owner_socket',
        'owner_key',
      ].sort(),
    );
    expect(manifest.owner_key).not.toBe(f.key);
    await expect(f.verify('admit', f.request, manifest.owner_key)).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    expect(admitted.owner_key_digest).not.toBe(second.launch(resources).owner_key_digest);
    expect(JSON.stringify(admitted)).not.toContain(manifest.owner_key);
    expect(() => first.materialize(resources)).toThrowError(
      expect.objectContaining({ code: 'toolkit_profile_changed' }),
    );
    expect(f.f.sent).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const kind of [
  'snapshot',
  'executable',
  'state-mode',
  'socket-mode',
  'child-manifest',
  'binding',
  'resource',
  'stop-proof',
] as const)
  test(`cleanup admission rejects changed ${kind} instead of inventing stop or root authority`, async () => {
    const f = await fixture(true);
    try {
      const snapshot = f.admission.cleanup(f.resources, f.resourceId);
      // This resource has a durable not-started proof, not an inferred free lock.
      await f.resources.stop(f.resourceId);
      const originalRow = f.resources.get(f.resourceId),
        originalBinding = f.f.service.agentpod!.bySession(f.session).binding,
        child = snapshot.materialize(f.resources),
        admitted = child.launch(f.resources);
      if (kind === 'snapshot')
        writeFileSync(snapshot.reference.path, readFileSync(snapshot.reference.path, 'utf8') + ' ');
      if (kind === 'executable')
        writeFileSync(admitted.launch.command, readFileSync(admitted.launch.command, 'utf8') + ' ');
      if (kind === 'state-mode') chmodSync(join(f.f.state, 'native-state'), 0o755);
      if (kind === 'socket-mode') chmodSync(f.f.service.socket, 0o666);
      if (kind === 'child-manifest')
        writeFileSync(
          admitted.launch.args[2]!,
          readFileSync(admitted.launch.args[2]!, 'utf8') + ' ',
        );
      if (kind === 'binding') {
        const binding = JSON.parse(f.f.service.agentpod!.bySession(f.session).binding);
        binding.principal_id = 'prn_00000000000000000003';
        f.f.service.store.db
          .prepare('UPDATE agentpod_admissions SET binding=? WHERE session_id=?')
          .run(JSON.stringify(binding), f.session);
      }
      if (kind === 'resource')
        f.f.service.store.db
          .prepare('UPDATE toolkit_resources SET spec=? WHERE id=?')
          .run('{}', f.resourceId);
      if (kind === 'stop-proof')
        f.f.service.store.db
          .prepare("UPDATE toolkit_resources SET stop_receipt='{}' WHERE id=?")
          .run(f.resourceId);
      expect(() => child.launch(f.resources)).toThrowError(
        expect.objectContaining({ code: 'toolkit_profile_changed' }),
      );
      // Restore the original persisted fixture bytes, never synthesize a stop.
      f.f.service.store.db
        .prepare('UPDATE toolkit_resources SET stop_receipt=?,spec=? WHERE id=?')
        .run(originalRow.stop_receipt, originalRow.spec, f.resourceId);
      f.f.service.store.db
        .prepare('UPDATE agentpod_admissions SET binding=? WHERE session_id=?')
        .run(originalBinding, f.session);
    } finally {
      await f.close();
    }
  });

test('actual private control role binds one owned PID, exact saved call and stop proof after revoked-root daemon recovery', async () => {
  const f = await fixture(true);
  let pending: Promise<unknown> | undefined;
  try {
    await f.client.connect(f.transport);
    const call = f.prepare();
    f.calls.deliver(call.id);
    await f.client.close();
    await f.resources.stop(f.resourceId);
    const binding = f.f.service.agentpod!.bySession(f.session).binding;
    f.f.service.agentpod!.revoke(JSON.parse(binding), randomUUID(), 'control callback proof');
    await f.f.service.supervisor.stopSession(f.session);
    await f.f.reopen();
    const service = f.f.service,
      resources = service.toolkitResources,
      admission = service.toolkitOwners.cleanup(f.resourceId).materialize(resources),
      admitted = admission.launch(resources),
      manifest = JSON.parse(readFileSync(admitted.launch.args[2]!, 'utf8')),
      input = {
        version: 1,
        action: 'fence',
        root_digest: f.request.root_digest,
        profile_digest: f.request.profile_digest,
        invocation_id: f.request.invocation_id,
        request_digest: call.request_digest,
        stop_proof_digest: digest(resources.stopProof(f.resourceId)),
        decision_id: '',
      },
      id = 'actual-cleanup-control',
      hold = join(f.f.state, 'control-hold');
    writeFileSync(hold, 'synthetic hold', { mode: 0o600 });
    const child = resources.control(id, admission, input);
    service.toolkitOwners.registerControl(id, admission);
    const verify = (body: unknown = input, key = manifest.owner_key) =>
      callControl(service.socket, body, key);
    await expect(verify()).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    pending = child.run();
    void pending.catch(() => {});
    await until(() => existsSync(join(f.f.state, 'control-seen.json')), Boolean);
    expect(resources.get(id)).toMatchObject({
      state: 'running',
      pid: expect.any(Number),
      identity: expect.any(String),
    });
    expect(await verify()).toEqual({
      version: 1,
      control_digest: digest(input),
      decision: 'allowed',
    });
    for (const [body, key] of [
      [input, f.key],
      [{ ...input, stop_proof_digest: '0'.repeat(64) }, manifest.owner_key],
      [{ ...input, action: 'inspect' }, manifest.owner_key],
      [{ ...input, root_digest: 'e'.repeat(64) }, manifest.owner_key],
    ])
      await expect(verify(body, key)).rejects.toThrowError(
        expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
      );
    expect(() => resources.assertLive(id)).toThrowError(
      expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }),
    );
    await expect(f.verify('admit', f.request, manifest.owner_key)).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    rmSync(hold);
    expect(await pending).toMatchObject({
      control_digest: digest(input),
      receipt: { state: 'outcome_unknown' },
    });
    await resources.stop(id);
    expect(resources.stopProof(id).method).toBe('observed_exit');
    await expect(verify()).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    expect(service.store.hasUnknown(f.session)).toBe(true);
    const acknowledgement = service.toolkitOwners.cleanup(f.resourceId).materialize(resources);
    expect(() =>
      resources.control('unbound-acknowledgement', acknowledgement, {
        ...input,
        action: 'acknowledge',
        decision_id: 'unbound-decision',
      }),
    ).toThrowError(expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }));
    expect(JSON.stringify(service.store.events(f.session, 0))).not.toContain(manifest.owner_key);
  } finally {
    await pending?.catch(() => {});
    await f.close();
  }
});

function callControl(socket: string, body: unknown, key: string) {
  return call<any>(socket, '/managed-toolkit/v1/control', body, key);
}

test('damaged durable cleanup delegation denies native grants and fences renewal before any effect dispatch', async () => {
  const f = await fixture(true);
  try {
    const reference = f.f.service.toolkitOwners.cleanup(f.resourceId).reference;
    expect(f.resources.get(f.resourceId)).toMatchObject({ state: 'prepared', pid: null });
    await f.client.connect(f.transport);
    const row = f.prepare();
    f.calls.deliver(row.id);
    writeFileSync(reference.path, readFileSync(reference.path, 'utf8') + ' ');
    await expect(f.verify('dispatch')).rejects.toThrowError(
      expect.objectContaining({ code: 'toolkit_owner_unavailable' }),
    );
    expect(f.calls.get(row.id).state).toBe('delivered');
    expect(() =>
      f.f.service.agentpod!.leaseWindow(f.session, f.request.root_digest, 90000),
    ).toThrowError(expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }));
  } finally {
    await f.close();
  }
});

for (const read of [true, false])
  for (const stop of ['root', 'turn'] as const)
    test(`${stop} cancellation atomically fences an actually dispatched native ${read ? 'read' : 'write'} without nesting transactions`, async () => {
      const f = await fixture(read);
      try {
        await f.client.connect(f.transport);
        const call = f.prepare();
        f.calls.deliver(call.id);
        if (call.operation_id) {
          const op = f.f.service.managed.operation(call.operation_id),
            a = f.f.service.managed.forOperation(op.id);
          f.f.service.managed.decide(
            a.id,
            'before-native-stop',
            a.revision,
            op.operation_digest,
            'approve',
          );
        }
        expect(await f.verify('dispatch')).toMatchObject({ decision: 'allowed' });
        let observed = 0;
        f.f.service.store.changes.on('event', (event) => {
          if (event.kind === 'toolkit.call.outcome_unknown') {
            expect(f.f.service.store.db.isTransaction).toBe(false);
            expect(f.calls.get(call.id)).toMatchObject({
              state: 'outcome_unknown',
              cancel_requested: 1,
            });
            observed++;
          }
        });
        if (stop === 'root')
          f.f.service.agentpod!.revoke(
            f.f.service.agentpod!.binding(f.session),
            randomUUID(),
            'native dispatch cancellation',
          );
        else f.f.service.cancellations.begin(f.session, randomUUID(), f.target, f.actor);
        expect(observed).toBe(1);
        expect(f.f.service.store.hasUnknown(f.session)).toBe(true);
        if (call.operation_id)
          expect(f.f.service.managed.operation(call.operation_id).state).toBe('outcome_unknown');
        await f.resources.stop(f.resourceId);
        expect(f.calls.get(call.id).state).toBe('outcome_unknown');
      } finally {
        await f.close();
      }
    });
