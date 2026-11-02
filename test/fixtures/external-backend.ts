import type { ExternalBackend, ExternalHooks } from '../../src/workers/external-runtime.js';
import type { ExternalRuntime, WorkerBinding } from '../../src/core/worker-binding.js';
import type { HarnessCheckpoint } from '../../src/harness/protocol.js';
import type { WorkspaceTree } from '../../src/core/records.js';
import { digest, ServiceError } from '../../src/core/protocol.js';

/** Deterministic transport only; never execution, live-model or interoperability evidence. */
export class FixtureExternalBackend implements ExternalBackend {
  runtime: ExternalRuntime = {
    id: 'fixture-acp',
    kind: 'harness',
    target: 'gemini-acp',
    version: '0.64.0',
    config_digest: digest('fixture'),
    adapter_digest: digest('fixture-adapter'),
    execution_identity: { version: 'fixture', kernel: 'fixture', arch: 'fixture' },
    boundary_digest: 'fixture',
    engine_id: 'fixture',
    evidence: 'fixture',
    model_usage: 'unknown',
    output_cap: 4096,
    max_model_requests: 8,
    files: true,
    commands: true,
  };
  calls: string[] = [];
  commands = 0;
  modelCalls = 0;
  warmup = false;
  stopFails = false;
  hold = false;
  runs = new Map<string, { tree: WorkspaceTree; stop: () => void; stopped: boolean }>();
  runtimes() {
    return [structuredClone(this.runtime)];
  }
  validate(runtime: ExternalRuntime) {
    if (digest(runtime) !== digest(this.runtime))
      throw new ServiceError('worker_binding_changed', 'Runtime configuration changed');
  }
  async execute(
    binding: WorkerBinding,
    run: string,
    _prompt: string,
    tree: WorkspaceTree,
    hooks: ExternalHooks,
  ) {
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(Error('Fixture transport stopped'));
    });
    void stopped.catch(() => {});
    const owned = { tree: structuredClone(tree), stopped: false, stop };
    this.runs.set(run, owned);
    const cp: HarnessCheckpoint = {
      schema_version: 1,
      dialect: 'acp',
      worker_id: binding.worker_id,
      attempt_id: binding.attempt_id,
      state: 'prepared',
      session_id: null,
      turn_id: null,
      prompt_digest: null,
      cancel_requested: false,
      result: null,
      load_session: true,
    };
    hooks.checkpoint(cp);
    hooks.receipt({ run_id: run, fixture: true });
    hooks.checkpoint({ ...cp, state: 'creating' });
    Object.assign(cp, { state: 'idle', session_id: 'owned-session-' + run });
    hooks.checkpoint(cp);
    if (this.warmup) hooks.modelRequest(run + ':warmup', 100, 4096);
    Object.assign(cp, { state: 'dispatching', prompt_digest: digest(_prompt) });
    hooks.checkpoint(cp);
    this.calls.push(run);
    cp.state = 'running';
    hooks.checkpoint(cp);
    for (let i = 0; i < this.modelCalls; i++) hooks.modelRequest(run + ':' + i, 100, 4096);
    const work = (async () => {
      if (this.hold) return stopped;
      for (const [id, kind, args] of [
        ['edit', 'write', { file_path: '/workspace/app.js', content: 'repaired fixture' }],
        ['test', 'command', { command: 'fixture-pass', cwd: '/workspace' }],
      ] as const) {
        hooks.assertActive();
        const decision = await hooks.permission('session/request_permission', {
          scope: { id, kind, arguments: args },
          session_id: cp.session_id,
        });
        if (decision === 'approve') {
          if (kind === 'write')
            owned.tree['app.js'] = {
              ...owned.tree['app.js']!,
              content: Buffer.from('repaired fixture\n').toString('base64'),
            };
          else this.commands++;
          hooks.toolResult(id, true, { id, actual: true });
        }
      }
      cp.state = 'terminal';
      cp.result = { stopReason: 'end_turn' };
      hooks.checkpoint(cp);
      return { result: cp.result };
    })();
    return Promise.race([work, stopped]);
  }
  async stop(run: string, _runtime: ExternalRuntime, _receipt: unknown) {
    if (this.stopFails) throw Error('Fixture stop outcome unknown');
    const r = this.runs.get(run);
    if (r) {
      r.stopped = true;
      r.stop();
    }
  }
  collect(run: string) {
    const r = this.runs.get(run)!;
    if (!r.stopped) throw Error('Still running');
    return structuredClone(r.tree);
  }
}
