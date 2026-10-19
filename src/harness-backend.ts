import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  lstatSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  createReadStream,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, relative, dirname, isAbsolute } from 'node:path';
import { DockerHarnessBoundary, type HarnessContainers } from './harness-container.js';
import { DockerCodingExecutor } from './coding-executor.js';
import { engineRequest, engineJson } from './execution-boundary.js';
import { HarnessProtocol, type HarnessCheckpoint } from './harness-protocol.js';
import { HARNESS_TARGETS, type HarnessTarget } from './harness-probe.js';
import { AnthropicHarnessGateway } from './harness-model-gateway.js';
import { HarnessWireBridge } from './harness-wire-bridge.js';
import { harnessToolIds, matchesCodexCommandScope } from './harness-tool-identity.js';
import { proveHarnessReadiness } from './harness-readiness.js';
import { ProviderCredentialStore, resolveProviderAuth } from './provider-auth.js';
import { providerRoute } from './provider-config.js';
import { readTree, validateTree, type WorkspaceTree } from './workspaces.js';
import { repositoryPath } from './repository-snapshots.js';
import { digest, canonical, ServiceError } from './protocol.js';
import type { ExternalBackend, ExternalRuntime, ExternalHooks } from './external-runtime.js';
import type { WorkerBinding } from './worker-boundary.js';
import { hostDigests } from './host.js';

export async function harnessRuntimeDigest(root: string): Promise<string> {
  const entries: unknown[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name),
        s = lstatSync(p);
      if (s.isDirectory()) await walk(p);
      else if (s.isSymbolicLink()) {
        if (!realpathSync(p).startsWith(root + '/'))
          throw Error('Runtime symlink escapes prepared artifact');
        entries.push({ path: relative(root, p), link: readlinkSync(p) });
      } else if (s.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(p)) hash.update(chunk);
        entries.push({
          path: relative(root, p),
          hash: hash.digest('hex'),
          executable: Boolean(s.mode & 0o111),
        });
      } else throw Error('Unsupported harness runtime artifact');
    }
  }
  await walk(root);
  return digest(entries);
}
export function assertHarnessArtifactRoot(root: string): void {
  const allowed = [
    'node_modules',
    'codex',
    'package.json',
    'package-lock.json',
    'runtime-manifest.json',
  ];
  if (
    !isAbsolute(root) ||
    realpathSync(root) !== root ||
    readdirSync(root).some((name) => !allowed.includes(name))
  )
    throw Error(
      'Select a dedicated prepared artifact root containing only pinned runtime packages; source, state and user configuration are excluded',
    );
}
interface Pin {
  id: string;
  target: HarnessTarget;
  version: string;
  runtime_root: string;
  runtime_digest: string;
  model: string;
  output: number;
  requests: number;
}
/** Host-owned registry and fixed launch templates. No project-controlled commands, inherited env or real keys enter containers. */
export class DockerHarnessBackend implements ExternalBackend {
  private pins: Pin[];
  private fileDigest: string;
  private boundary?: DockerHarnessBoundary;
  private descriptors: ExternalRuntime[] = [];
  private protocols = new Map<string, HarnessProtocol>();
  private receipts = new Map<string, HarnessContainers>();
  constructor(
    readonly path: string,
    readonly root: string,
    readonly socket: string,
    readonly executor: DockerCodingExecutor,
    readonly docker = process.platform === 'darwin'
      ? '/opt/homebrew/bin/docker'
      : '/usr/bin/docker',
  ) {
    const stat = lstatSync(path),
      bytes = readFileSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      bytes.length > 65536
    )
      throw Error('Harness config must be an owner-only regular file, at most 64 KiB');
    this.fileDigest = digest(bytes.toString());
    const value = JSON.parse(bytes.toString());
    if (
      value.schema !== 1 ||
      Object.keys(value).some((k) => !['schema', 'runtimes'].includes(k)) ||
      !Array.isArray(value.runtimes) ||
      value.runtimes.length > 8
    )
      throw Error('Unsupported harness registry');
    const ids = new Set<string>();
    this.pins = value.runtimes.map((p: Pin) => {
      if (
        Object.keys(p).some(
          (k) =>
            ![
              'id',
              'target',
              'version',
              'runtime_root',
              'runtime_digest',
              'model',
              'output',
              'requests',
            ].includes(k),
        ) ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) ||
        ids.has(p.id) ||
        !Object.hasOwn(HARNESS_TARGETS, p.target) ||
        p.version !== HARNESS_TARGETS[p.target].version ||
        !isAbsolute(p.runtime_root) ||
        realpathSync(p.runtime_root) !== p.runtime_root ||
        !/^[a-f0-9]{64}$/.test(p.runtime_digest) ||
        p.model !== 'claude-sonnet-4-6' ||
        !Number.isSafeInteger(p.output) ||
        p.output < 1 ||
        p.output > 8192 ||
        !Number.isSafeInteger(p.requests) ||
        p.requests < 1 ||
        p.requests > 32
      )
        throw Error('Select exact reviewed harness artifacts and the tested Sonnet 4.6 route');
      ids.add(p.id);
      assertHarnessArtifactRoot(p.runtime_root);
      return structuredClone(p);
    });
  }
  async prepare(): Promise<void> {
    if (this.executor.evidence.probe !== 'passed')
      throw Error('Harness requires a proven real executor');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const p of this.pins) {
      if ((await harnessRuntimeDigest(p.runtime_root)) !== p.runtime_digest)
        throw Error('Harness runtime artifact changed');
      if (p.target !== 'codex-app-server') {
        const pkg = JSON.parse(
          readFileSync(
            join(
              p.runtime_root,
              'node_modules',
              p.target === 'gemini-acp'
                ? '@google/gemini-cli/package.json'
                : '@zed-industries/claude-agent-acp/package.json',
            ),
            'utf8',
          ),
        );
        if (pkg.version !== p.version) throw Error('Harness package version differs from its pin');
      }
    }
    const executable = realpathSync(this.docker);
    this.boundary = new DockerHarnessBoundary(engineRequest(this.socket), this.executor.engineId, {
      executable,
      digest: createHash('sha256').update(readFileSync(executable)).digest('hex'),
      socket: this.socket,
    });
    await proveHarnessReadiness(this.boundary, this.root);
    this.descriptors = this.pins.map((p) => ({
      id: p.id,
      kind: 'harness',
      target: p.target,
      version: p.version,
      config_digest: digest(p),
      adapter_digest: hostDigests().build_digest,
      execution_identity: {
        version: String(this.executor.evidence.engine_version),
        kernel: String(this.executor.evidence.kernel),
        arch: String(this.executor.evidence.arch),
      },
      boundary_digest: this.boundary!.profileDigest,
      engine_id: this.executor.engineId,
      evidence: 'proven',
      model_usage: 'unknown',
      provider_route: {
        provider: 'anthropic',
        model: p.model,
        wire:
          p.target === 'claude-acp'
            ? 'anthropic'
            : p.target === 'gemini-acp'
              ? 'google'
              : 'responses',
        wire_model: p.target === 'gemini-acp' ? 'gemini-2.5-flash' : p.model,
      },
      output_cap: p.output,
      max_model_requests: p.requests,
      files: true,
      commands: true,
    }));
  }
  runtimes(): ExternalRuntime[] {
    return structuredClone(this.descriptors);
  }
  validate(runtime: ExternalRuntime): void {
    if (
      !this.boundary ||
      digest(readFileSync(this.path, 'utf8')) !== this.fileDigest ||
      !this.descriptors.some((r) => digest(r) === digest(runtime))
    )
      throw new ServiceError(
        'worker_binding_changed',
        'Operator runtime configuration or proven boundary changed',
      );
  }
  assertAuthority(runtime: ExternalRuntime, tools: readonly string[]): void {
    if (runtime.target === 'codex-app-server' && !tools.includes('salaam_command'))
      throw new ServiceError(
        'runtime_role_unsupported',
        'The pinned Codex route requires an explicitly command-enabled profile',
      );
  }
  private runRoot(run: string): string {
    if (!/^[0-9a-f-]{36}$/.test(run)) throw Error('Invalid owned run ID');
    return join(this.root, run);
  }
  async execute(
    binding: WorkerBinding,
    run: string,
    prompt: string,
    tree: WorkspaceTree,
    hooks: ExternalHooks,
  ): Promise<{ result: unknown }> {
    this.validate(binding.external!);
    const pin = this.pins.find((p) => p.id === binding.external!.id)!;
    if ((await harnessRuntimeDigest(pin.runtime_root)) !== pin.runtime_digest)
      throw Error('Harness runtime changed before launch');
    hooks.assertActive();
    const dir = this.runRoot(run),
      work = join(dir, 'workspace'),
      home = join(dir, 'home'),
      token = randomUUID() + randomUUID();
    if (existsSync(dir))
      throw new ServiceError(
        'harness_replay',
        'Owned runtime directory already exists; reconcile without replay',
      );
    for (const p of [dir, work, home]) mkdirSync(p, { mode: 0o700 });
    validateTree(tree);
    for (const [p, file] of Object.entries(tree)) {
      repositoryPath(p);
      mkdirSync(dirname(join(work, p)), { recursive: true, mode: 0o700 });
      writeFileSync(join(work, p), Buffer.from(file.content, 'base64'), {
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    const codex = pin.target === 'codex-app-server',
      claude = pin.target === 'claude-acp';
    const files = binding.tools.includes('salaam_files'),
      commands = binding.tools.includes('salaam_command');
    const tools = codex
      ? commands
        ? ['exec_command']
        : []
      : claude
        ? [
            'Read',
            'Glob',
            'Grep',
            ...(files ? ['Edit', 'Write'] : []),
            ...(commands ? ['Bash'] : []),
          ]
        : [
            'list_directory',
            'read_file',
            'grep_search',
            'glob',
            ...(files ? ['replace', 'write_file'] : []),
            ...(commands ? ['run_shell_command'] : []),
          ];
    let args: string[], env: Record<string, string>;
    if (codex) {
      mkdirSync(join(home, '.codex'));
      writeFileSync(
        join(home, '.codex/config.toml'),
        `model = "${pin.model}"\nmodel_provider = "salaam"\n[model_providers.salaam]\nname = "Salaam explicit Claude gateway"\nbase_url = "http://127.0.0.1:47123/v1"\nenv_key = "ANTHROPIC_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
        { mode: 0o600 },
      );
      const arch = this.executor.evidence.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const binary = '/runtime/codex/vendor/' + arch + '-unknown-linux-musl/bin/codex';
      const wrapper = `const cp=require('node:child_process');if(cp.execFileSync(${JSON.stringify(binary)},['--version'],{encoding:'utf8'}).trim()!=='codex-cli ${pin.version}')process.exit(2);const c=cp.spawn(${JSON.stringify(binary)},['app-server'],{stdio:'inherit',env:process.env});c.on('exit',n=>process.exit(n??1));c.on('error',()=>process.exit(2));`;
      args = ['/usr/local/bin/node', '-e', wrapper];
      env = { CODEX_HOME: '/home/agent/.codex', ANTHROPIC_API_KEY: token };
    } else if (claude) {
      args = [
        '/usr/local/bin/node',
        '/runtime/node_modules/@zed-industries/claude-agent-acp/dist/index.js',
      ];
      env = {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47123',
        ANTHROPIC_API_KEY: token,
        ANTHROPIC_MODEL: pin.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: pin.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: pin.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: pin.model,
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };
    } else {
      args = [
        '/usr/local/bin/node',
        '/runtime/node_modules/@google/gemini-cli/bundle/gemini.js',
        '--acp',
        '--model',
        'gemini-2.5-flash',
      ];
      env = {
        GEMINI_API_KEY: token,
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:47123',
        GEMINI_CLI_NO_RELAUNCH: 'true',
        DISABLE_TELEMETRY: '1',
      };
    }
    const receipt = await this.boundary!.prepare(run, work, pin.runtime_root, home, args, env);
    this.receipts.set(run, receipt);
    hooks.receipt(receipt);
    const intents = new Map<
      string,
      { id: string; name: string; arguments: Record<string, unknown> }
    >();
    const checkBoundary = async () => {
      try {
        hooks.assertActive();
        await this.boundary!.assert(receipt);
        const info = engineJson(await engineRequest(this.socket)('GET', '/info'));
        const identity = binding.external!.execution_identity;
        if (info.ServerVersion !== identity.version || info.KernelVersion !== identity.kernel)
          throw Error('Harness engine version or kernel changed');
      } catch (error) {
        try {
          hooks.failed(error as Error);
        } catch {}
        throw error;
      }
    };
    const gateway = new AnthropicHarnessGateway({
      model: pin.model,
      output: pin.output,
      token,
      credential: async () => {
        const auth = await resolveProviderAuth(
          providerRoute('anthropic', pin.model, pin.output),
          new ProviderCredentialStore(),
          {},
        );
        if (!auth.auth.apiKey) throw Error('No operator-configured Claude credential');
        return auth.auth.apiKey;
      },
      admit: hooks.modelRequest,
    });
    const bridge = claude
      ? null
      : new HarnessWireBridge(
          gateway,
          {
            protocol: codex ? 'responses' : 'google',
            model: codex ? pin.model : 'gemini-2.5-flash',
            tools,
          },
          (intent) => {
            for (const id of harnessToolIds(pin.target, pin.version, intent))
              intents.set(id, intent);
          },
        );
    await this.boundary!.gateway(receipt, async (request) => {
      await checkBoundary();
      if (bridge) return bridge.request(request);
      const body = JSON.parse(request.body.toString());
      if (Array.isArray(body.tools))
        body.tools = body.tools.filter((t: any) => tools.includes(t.name));
      return gateway.request({ ...request, body: Buffer.from(JSON.stringify(body)) });
    });
    const checkpoint: HarnessCheckpoint = {
      schema_version: 1,
      dialect: codex ? 'codex' : 'acp',
      worker_id: binding.worker_id,
      attempt_id: binding.attempt_id,
      state: 'prepared',
      session_id: null,
      turn_id: null,
      prompt_digest: null,
      cancel_requested: false,
      result: null,
      load_session: false,
    };
    hooks.checkpoint(checkpoint);
    const protocol = new HarnessProtocol(
      await this.boundary!.launchHarness(receipt, checkpoint.dialect),
      checkpoint,
      {
        save: hooks.checkpoint,
        permission: async (owned) => {
          await checkBoundary();
          const params = owned.params as any,
            call = params.toolCall,
            known = intents.get(codex ? params.itemId : call?.toolCallId);
          let scope:
            | { id: string; kind: 'write' | 'command'; arguments: Record<string, unknown> }
            | undefined;
          if (codex) {
            if (matchesCodexCommandScope(pin.version, known, params))
              scope = {
                id: params.itemId,
                kind: 'command',
                arguments: { cmd: known!.arguments.cmd, cwd: params.cwd },
              };
          } else {
            const input = (claude ? call?.rawInput : known?.arguments) as
              Record<string, unknown> | undefined;
            const name = claude ? call?.title : known?.name;
            if (input && typeof input.command === 'string')
              scope = { id: call.toolCallId, kind: 'command', arguments: input };
            else if (
              input &&
              typeof input.file_path === 'string' &&
              (claude || ['replace', 'write_file'].includes(String(name)))
            ) {
              if (input.file_path.startsWith('/workspace/'))
                repositoryPath(input.file_path.slice('/workspace/'.length));
              else return 'deny';
              scope = { id: call.toolCallId, kind: 'write', arguments: input };
            }
          }
          if (!scope) return 'deny';
          const decision = await hooks.permission(owned.method, {
            scope,
            upstream_session: owned.session_id,
            upstream_turn: owned.turn_id,
            request_digest: digest(params),
          });
          await checkBoundary();
          return decision;
        },
        event: (method, params) => {
          const p = params as any;
          if (
            !codex &&
            method === 'session/update' &&
            p.update?.sessionUpdate === 'tool_call_update' &&
            ['completed', 'failed'].includes(p.update.status)
          )
            hooks.toolResult(p.update.toolCallId, p.update.status === 'completed', p.update);
          if (
            codex &&
            method === 'item/completed' &&
            ['commandExecution', 'fileChange'].includes(p.item?.type)
          )
            hooks.toolResult(
              p.item.id,
              p.item.status === 'completed' &&
                (p.item.exitCode === undefined || p.item.exitCode === 0),
              p.item,
            );
        },
      },
    );
    this.protocols.set(run, protocol);
    await protocol.initialize(!codex);
    if (!codex)
      await protocol.rpc.request(
        'authenticate',
        {
          methodId: 'gateway',
          _meta: {
            ...(claude ? {} : { 'api-key': token }),
            gateway: { baseUrl: 'http://127.0.0.1:47123', headers: { 'x-api-key': token } },
          },
        },
        30000,
      );
    await protocol.create(
      codex
        ? {
            cwd: '/workspace',
            model: pin.model,
            modelProvider: 'salaam',
            sandbox: 'danger-full-access',
            approvalPolicy: 'untrusted',
          }
        : {
            cwd: '/workspace',
            mcpServers: [],
            ...(claude
              ? {
                  _meta: {
                    claudeCode: {
                      options: {
                        model: pin.model,
                        settingSources: [],
                        plugins: [],
                        tools,
                        disallowedTools: [
                          'Skill',
                          'Task',
                          'Agent',
                          'WebFetch',
                          'WebSearch',
                          'AskUserQuestion',
                        ],
                        maxTurns: pin.requests,
                        maxThinkingTokens: 1024,
                      },
                    },
                  },
                }
              : {}),
          },
    );
    return { result: await protocol.prompt(prompt) };
  }
  async stop(run: string, runtime: ExternalRuntime, _receipt: unknown): Promise<void> {
    if (
      !this.boundary ||
      runtime.engine_id !== this.executor.engineId ||
      runtime.boundary_digest !== this.boundary.profileDigest
    )
      throw Error('Cannot establish the original harness engine/profile for cleanup');
    try {
      await this.protocols.get(run)?.close();
    } finally {
      this.protocols.delete(run);
      await this.boundary.cleanupRun(run);
      this.receipts.delete(run);
    }
  }
  collect(run: string, _runtime: ExternalRuntime): WorkspaceTree {
    return readTree(join(this.runRoot(run), 'workspace'));
  }
}
