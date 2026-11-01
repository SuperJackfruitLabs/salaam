import { canonical, digest, ServiceError } from '../core/protocol.js';
import { hostDigests } from '../host/host.js';
import { A2AHttp, A2A_PIN, a2aObject, privateJSON, validatePeer, type A2APeer } from './peer.js';
import { A2AInvocation, type A2ACheckpoint } from './protocol.js';
import type { ExternalBackend, ExternalHooks } from '../workers/external-runtime.js';
import type { ExternalRuntime, WorkerBinding } from '../core/worker-binding.js';
import type { WorkspaceTree } from '../core/records.js';

/** Bounded outbound analysis. A peer has no local file/command/controller authority. */
export class A2ABackend implements ExternalBackend {
  private peers: A2APeer[];
  private ready = false;
  private active = new Map<string, A2AInvocation>();
  private trees = new Map<string, WorkspaceTree>();
  constructor(readonly config: string) {
    this.peers = this.read();
  }
  private read(): A2APeer[] {
    const config = a2aObject(privateJSON(this.config));
    if (
      Object.keys(config).sort().join(',') !== 'peers,schema' ||
      config.schema !== 1 ||
      !Array.isArray(config.peers) ||
      !config.peers.length ||
      config.peers.length > 16
    )
      throw Error('Expected bounded A2A peer registry schema 1');
    const peers = config.peers.map(validatePeer);
    if (new Set(peers.map((p) => p.id)).size !== peers.length)
      throw Error('Duplicate peer identity');
    return peers;
  }
  private descriptor(p: A2APeer): ExternalRuntime {
    return {
      id: p.id,
      kind: 'a2a',
      target: 'a2a',
      version: A2A_PIN.wire,
      config_digest: digest(p),
      adapter_digest: hostDigests().build_digest,
      execution_identity: {
        version: A2A_PIN.wire,
        kernel: 'remote-unobserved',
        arch: 'remote-unobserved',
      },
      boundary_digest: digest({ protocol: A2A_PIN, peer: p, authority: 'remote-analysis-only' }),
      engine_id: p.id,
      evidence: 'proven',
      model_usage: 'unknown',
      output_cap: null,
      max_model_requests: null,
      files: false,
      commands: false,
    };
  }
  async prepare(): Promise<void> {
    this.peers = this.read();
    this.ready = true;
  }
  async close(): Promise<void> {
    this.active.clear();
    this.trees.clear();
    this.ready = false;
  }
  runtimes(): ExternalRuntime[] {
    return this.ready ? this.peers.map((p) => this.descriptor(p)) : [];
  }
  validate(runtime: ExternalRuntime): void {
    const p = this.read().find((p) => p.id === runtime.id);
    if (!this.ready || !p || canonical(this.descriptor(p)) !== canonical(runtime))
      throw Error('A2A peer/config/credential/build admission changed');
  }
  assertAuthority(_runtime: ExternalRuntime, tools: readonly string[]): void {
    if (
      tools.some((t) =>
        [
          'salaam_files',
          'salaam_command',
          'salaam_team',
          'salaam_managed',
          'salaam_children',
        ].includes(t),
      )
    )
      throw Error('A2A peers are analysis specialists without local tools');
  }
  async execute(
    binding: WorkerBinding,
    run: string,
    prompt: string,
    tree: WorkspaceTree,
    hooks: ExternalHooks,
  ): Promise<{ result: unknown }> {
    this.validate(binding.external!);
    this.assertAuthority(binding.external!, binding.tools);
    hooks.assertActive();
    if (this.active.has(run) || this.trees.has(run))
      throw Error('A2A invocation cannot be replayed');
    const p = this.peers.find((p) => p.id === binding.external!.id)!,
      http = new A2AHttp(p);
    const files: Record<string, string> = Object.create(null),
      disclosure: A2ACheckpoint['disclosure'] = [];
    for (const path of p.files) {
      const f = tree[path];
      if (!f) throw Error('An explicitly disclosed repository file is absent');
      const bytes = Buffer.from(f.content, 'base64'),
        text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes) || bytes.length > 65536)
        throw Error('Only bounded UTF-8 peer disclosure is supported');
      files[path] = text;
      disclosure.push({ path, digest: digest(f), bytes: bytes.length });
    }
    const data = { skill: p.skill, files },
      peer = { id: p.id, tenant: p.tenant, digest: digest(p), cancel: p.cancel, skill: p.skill };
    if (canonical({ prompt, data }).length > 196608) throw Error('A2A disclosure exceeds bound');
    const initial = A2AInvocation.prepare(
      binding.worker_id,
      binding.attempt_id,
      peer,
      prompt,
      data,
      disclosure,
    );
    initial.run_id = run;
    // Both identity and disclosure are durable before any SendMessage bytes leave.
    hooks.checkpoint(initial);
    hooks.receipt(initial);
    const invocation = new A2AInvocation(peer, initial, http, (cp) => {
      hooks.checkpoint(cp);
      hooks.receipt(cp);
      return undefined;
    });
    this.active.set(run, invocation);
    this.trees.set(run, structuredClone(tree));
    await http.card();
    hooks.assertActive();
    let task = await invocation.dispatch(prompt, data);
    const end = Date.now() + 180000;
    while (invocation.view().state !== 'terminal') {
      hooks.assertActive();
      this.validate(binding.external!);
      if (['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(task.status.state))
        throw Error('Peer needs input/authentication; explicit operator resolution required');
      if (Date.now() >= end) throw Error('Peer deadline reached; remote work may still run');
      if (p.streaming) {
        try {
          await http.subscribe(invocation.view().task_id!, (event) => {
            hooks.assertActive();
            invocation.observe(event);
          });
        } catch (error) {
          if (error instanceof ServiceError) throw error;
        }
      } else await new Promise((r) => setTimeout(r, 2500));
      hooks.assertActive();
      task = await invocation.inspect();
    }
    if (task.status.state !== 'TASK_STATE_COMPLETED')
      throw Error('Remote task ended without a completed result');
    return {
      result: {
        peer: p.id,
        tenant: p.tenant,
        task,
        disclosure,
        prompt_digest: digest(prompt),
        verified_success: false,
        remote_execution: 'unobserved',
      },
    };
  }
  collect(run: string): WorkspaceTree {
    const tree = this.trees.get(run);
    if (!tree) throw Error('No owned local snapshot for remote analysis');
    this.trees.delete(run);
    return tree;
  }
  async stop(run: string, runtime: ExternalRuntime, receipt: unknown): Promise<unknown> {
    this.validate(runtime);
    let invocation = this.active.get(run);
    if (!invocation) {
      const record = a2aObject(receipt);
      const cp = a2aObject(record.checkpoint ?? record) as A2ACheckpoint,
        p = this.peers.find((p) => p.id === runtime.id)!;
      if (cp.run_id !== run) throw Error('Remote cleanup receipt belongs to another local run');
      invocation = new A2AInvocation(
        { id: p.id, tenant: p.tenant, digest: digest(p), cancel: p.cancel, skill: p.skill },
        cp,
        new A2AHttp(p),
        () => undefined,
      );
    }
    if (invocation.view().state === 'prepared') {
      this.active.delete(run);
      this.trees.delete(run);
      return { scope: 'never-dispatched', checkpoint: invocation.view() };
    }
    await invocation.cancel();
    if (invocation.view().state !== 'terminal')
      throw Error('Remote terminal receipt is unconfirmed');
    this.active.delete(run);
    if (invocation.view().result?.status.state !== 'TASK_STATE_COMPLETED') this.trees.delete(run);
    return { scope: 'remote-terminal-receipt', checkpoint: invocation.view() };
  }
}

export class ExternalBackends implements ExternalBackend {
  constructor(readonly backends: ExternalBackend[]) {}
  async prepare(): Promise<void> {
    for (const b of this.backends) await b.prepare?.();
    const ids = this.runtimes().map((r) => r.id);
    if (new Set(ids).size !== ids.length)
      throw Error('Runtime IDs must be unique across local and remote backends');
  }
  async close(): Promise<void> {
    for (const b of this.backends) await b.close?.();
  }
  runtimes(): ExternalRuntime[] {
    return this.backends.flatMap((b) => b.runtimes());
  }
  private owner(runtime: ExternalRuntime): ExternalBackend {
    const b = this.backends.find((b) => b.runtimes().some((r) => r.id === runtime.id));
    if (!b) throw Error('Runtime is unavailable');
    return b;
  }
  validate(runtime: ExternalRuntime): void {
    this.owner(runtime).validate(runtime);
  }
  assertAuthority(runtime: ExternalRuntime, tools: readonly string[]): void {
    this.owner(runtime).assertAuthority?.(runtime, tools);
  }
  execute(
    binding: WorkerBinding,
    run: string,
    prompt: string,
    tree: WorkspaceTree,
    hooks: ExternalHooks,
  ): Promise<{ result: unknown }> {
    return this.owner(binding.external!).execute(binding, run, prompt, tree, hooks);
  }
  collect(run: string, runtime: ExternalRuntime): WorkspaceTree {
    return this.owner(runtime).collect(run, runtime);
  }
  stop(run: string, runtime: ExternalRuntime, receipt: unknown): Promise<unknown> {
    return this.owner(runtime).stop(run, runtime, receipt);
  }
}
