import {
  loadDangerClassifierOptions,
  SANDBOX_LEVELS,
  type SandboxLevel,
} from '../../local/index.js';
import { loadWebSearchConfig } from '../../web/index.js';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { digest, call, canonical } from '../../core/index.js';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { operatorMcpPath, readOperatorMcpFile } from '../../mcp/index.js';
import { defaultAgentPodConfig } from '../../agentpod/index.js';
import { SalaamService } from '../../service/index.js';
import {
  providerRoute,
  providerHasOutputCap,
  resolveProviderAuth,
  bindProviderConfiguration,
} from '../../providers/index.js';
import { SocketEffectConnector } from '../../execution/index.js';
import type { CliContext } from './context.js';

export const SERVICE_HELP = `salaam service start [--foreground] [--provider PROVIDER]
                     [--model MODEL] [--max-output-tokens N] [--workspace-id ID]
                     [--effect-socket PATH] [--effect-opaque]
                     [--coding-root PRIVATE_DIR] [--coding-socket DOCKER_SOCKET]
                     [--harness-config OWNER_ONLY_FILE] [--a2a-config OWNER_ONLY_FILE]
                     [--a2a-listen-config OWNER_ONLY_FILE]
                     [--agentpod-config OWNER_ONLY_FILE] [--mcp-config FILE]
                     [--tools-user USER]
                     [--local-sandbox read-only|workspace-write|full-access]
                     [--local-sandbox-read PATH,…|toolchain] [--unsandboxed-commands allow]
salaam service status
salaam service stop

--tools-user USER (or SALAAM_TOOLS_USER) runs local agent commands and edits as
USER through sudo -n -u USER on Linux. Without it, tools share the provider
credential's OS user and start prints a warning.

Local commands (session create --local-coding) run under the host OS sandbox:
bubblewrap on Linux, Seatbelt on macOS. --local-sandbox (or SALAAM_LOCAL_SANDBOX)
picks the level: workspace-write (default) writes only inside the workspace,
read-only writes nothing, full-access runs commands unsandboxed with network. A
sandboxed command has no network and cannot read outside the workspace and the
system; --local-sandbox-read (or SALAAM_LOCAL_SANDBOX_READ) lists read-only paths
it may also read, comma-separated, and "toolchain" adds this host's node prefix,
~/.npm, ~/.nvm, ~/.cargo, ~/.rustup, ~/go and ~/.gitconfig where present. Home
itself and credential directories (~/.ssh, ~/.aws, keychains …) are refused. On
macOS commands get the real git from the active developer dir. A host with no
usable sandbox refuses commands unless --unsandboxed-commands allow.

Without --agentpod-config, start binds to ~/.config/salaam/agentpod-pins.json
($XDG_CONFIG_HOME/salaam) when that file exists.

The default provider is offline. Anthropic defaults to claude-sonnet-5-5.
Other providers require --model; use salaam providers list and salaam models list PROVIDER.
Start with --foreground for process-supervisor use; otherwise the service detaches.
An AgentPod daemon requires node-bound admissions and a fresh authority lease.
Keep its private state outside the pinned workspace. Coding, external runtimes,
effect connectors and managed MCP are unavailable in this profile.`;

/** salaam service start, in the foreground or as a detached service. */
export async function serviceStartCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, state, socket, foreground, group, verb } = ctx;
  if (group === 'service' && verb === 'start') {
    const provider = option('--provider') ?? 'offline';
    const model = option('--model');
    const cap = option('--max-output-tokens');
    const workspace = option('--workspace-id');
    let route = providerRoute(
      provider,
      model,
      cap === undefined ? undefined : Number(cap),
      workspace,
    );
    if (route.provider !== 'salaam-proof') {
      const auth = await resolveProviderAuth(route);
      if (cap !== undefined && !providerHasOutputCap(route, auth))
        throw new Error(
          'This authentication cannot enforce --max-output-tokens; omit it and explicitly disable token budgeting in task plans',
        );
      route = bindProviderConfiguration(route, auth);
    }
    const effectSocket = option('--effect-socket');
    const opaque = args.includes('--effect-opaque');
    const codingRoot = option('--coding-root'),
      codingSocket = option('--coding-socket'),
      harnessConfig = option('--harness-config'),
      a2aConfig = option('--a2a-config'),
      agentpodConfig =
        option('--agentpod-config') ?? defaultAgentPodConfig(process.env, existsSync),
      a2aListenConfig = option('--a2a-listen-config'),
      mcpConfig = resolve(option('--mcp-config') ?? operatorMcpPath(process.env)),
      toolsUser = option('--tools-user') ?? (process.env.SALAAM_TOOLS_USER || undefined),
      localSandbox = option('--local-sandbox') ?? (process.env.SALAAM_LOCAL_SANDBOX || undefined),
      unsandboxedCommands =
        option('--unsandboxed-commands') ?? (process.env.SALAAM_UNSANDBOXED_COMMANDS || undefined),
      localSandboxRead = (
        option('--local-sandbox-read') ??
        (process.env.SALAAM_LOCAL_SANDBOX_READ || '')
      )
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      webSearchConfig =
        option('--web-search-config') ?? (process.env.SALAAM_WEB_SEARCH_CONFIG || undefined),
      dangerClassifierConfig =
        option('--danger-classifier-config') ??
        (process.env.SALAAM_DANGER_CLASSIFIER_CONFIG || undefined);
    // Fail early on a bad command-reviewer config; its key is read from the named variable, never printed.
    if (dangerClassifierConfig)
      loadDangerClassifierOptions(
        JSON.parse(readFileSync(resolve(dangerClassifierConfig), 'utf8')),
      );
    // Fail early on a bad web search config; its keys are read, never printed.
    if (webSearchConfig) loadWebSearchConfig(resolve(webSearchConfig));
    if (localSandbox !== undefined && !(SANDBOX_LEVELS as readonly string[]).includes(localSandbox))
      throw Error('--local-sandbox is read-only, workspace-write or full-access');
    if (unsandboxedCommands !== undefined && unsandboxedCommands !== 'allow')
      throw Error('--unsandboxed-commands is allow or absent');
    if (foreground) {
      const service = await SalaamService.open({
        stateDir: state,
        providerRoute: route,
        agentpodConfig: agentpodConfig ? resolve(agentpodConfig) : undefined,
        operatorMcpConfig: mcpConfig,
        codingRoot: codingRoot ? resolve(codingRoot) : undefined,
        codingSocket: codingSocket ? resolve(codingSocket) : undefined,
        harnessConfig: harnessConfig ? resolve(harnessConfig) : undefined,
        a2aConfig: a2aConfig ? resolve(a2aConfig) : undefined,
        a2aListenConfig: a2aListenConfig ? resolve(a2aListenConfig) : undefined,
        toolsUser,
        ...(localSandbox ? { localSandbox: localSandbox as SandboxLevel } : {}),
        ...(unsandboxedCommands ? { unsandboxedCommands: 'allow' as const } : {}),
        ...(localSandboxRead.length ? { localSandboxReadPaths: localSandboxRead } : {}),
        ...(webSearchConfig ? { webSearchConfig: resolve(webSearchConfig) } : {}),
        ...(dangerClassifierConfig
          ? { dangerClassifierConfig: resolve(dangerClassifierConfig) }
          : {}),
        effectConnector: effectSocket
          ? new SocketEffectConnector(resolve(effectSocket), { opaque })
          : undefined,
      });
      const warning = service.supervisor.providerCapabilities().warning;
      if (warning) console.error(warning);
      // Only a live provider has a credential to share; the offline proof route stays quiet.
      if (service.toolIdentity.warning && route.provider !== 'salaam-proof')
        console.error('warning: ' + service.toolIdentity.warning);
      process.stdout.write(JSON.stringify({ socket, service: 'started' }) + '\n');
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void service.close().catch(() => {
            console.error('Salaam stopped with a persistence error');
            process.exitCode = 1;
          });
        });
      await service.closed;
      return true;
    }
    let health:
      | {
          provider_route?: unknown;
          coding_root?: string | null;
          coding_socket?: string | null;
          agentpod_config?: string | null;
          agentpod_pins_digest?: string | null;
          operator_mcp?: { config: string; digest: string } | null;
        }
      | undefined;
    try {
      health = await call(socket, '/v1/health');
    } catch {
      // An unreachable service reads as no health.
    }
    if (health) {
      if (
        (health.agentpod_config ?? null) !== (agentpodConfig ? resolve(agentpodConfig) : null) ||
        (agentpodConfig &&
          health.agentpod_pins_digest !==
            digest(JSON.parse(readFileSync(resolve(agentpodConfig), 'utf8'))))
      )
        throw new Error(
          'Service is already running with different AgentPod authority pins; stop it first',
        );
      if (canonical(health.provider_route ?? providerRoute()) !== canonical(route))
        throw new Error('Service is already running with another provider route; stop it first');
      if (
        (health.coding_root ?? null) !== (codingRoot ? resolve(codingRoot) : null) ||
        (health.coding_socket ?? null) !== (codingSocket ? resolve(codingSocket) : null)
      )
        throw new Error(
          'Service is already running with another coding configuration; stop it first',
        );
      if ((health.operator_mcp?.config ?? null) !== mcpConfig)
        throw new Error('Service is already running with another MCP config; stop it first');
      if (
        health.operator_mcp &&
        health.operator_mcp.digest !== digest(readOperatorMcpFile(mcpConfig))
      )
        console.error(
          'Declared MCP servers changed since the service started; run salaam service stop, then start, to apply them',
        );
      console.log('Salaam service already running');
      return true;
    }
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const fd = openSync(join(state, 'service.log'), 'a', 0o600);
    const child = spawn(
      process.execPath,
      [
        // The detached service runs the CLI itself again, in the foreground.
        fileURLToPath(new URL('../cli.js', import.meta.url)),
        'service',
        'start',
        '--foreground',
        '--state',
        state,
        '--provider',
        provider,
        ...(model ? ['--model', model] : []),
        ...(cap ? ['--max-output-tokens', cap] : []),
        ...(workspace ? ['--workspace-id', workspace] : []),
        ...(effectSocket ? ['--effect-socket', resolve(effectSocket)] : []),
        ...(opaque ? ['--effect-opaque'] : []),
        ...(codingRoot ? ['--coding-root', resolve(codingRoot)] : []),
        ...(codingSocket ? ['--coding-socket', resolve(codingSocket)] : []),
        ...(harnessConfig ? ['--harness-config', resolve(harnessConfig)] : []),
        ...(a2aConfig ? ['--a2a-config', resolve(a2aConfig)] : []),
        ...(agentpodConfig ? ['--agentpod-config', resolve(agentpodConfig)] : []),
        ...(a2aListenConfig ? ['--a2a-listen-config', resolve(a2aListenConfig)] : []),
        '--mcp-config',
        mcpConfig,
        ...(toolsUser ? ['--tools-user', toolsUser] : []),
        ...(localSandbox ? ['--local-sandbox', localSandbox] : []),
        ...(unsandboxedCommands ? ['--unsandboxed-commands', 'allow'] : []),
        ...(localSandboxRead.length ? ['--local-sandbox-read', localSandboxRead.join(',')] : []),
        ...(webSearchConfig ? ['--web-search-config', resolve(webSearchConfig)] : []),
        ...(dangerClassifierConfig
          ? ['--danger-classifier-config', resolve(dangerClassifierConfig)]
          : []),
      ],
      { detached: true, stdio: ['ignore', fd, fd] },
    );
    closeSync(fd);
    child.unref();
    for (let i = 0; i < 150; i++) {
      try {
        const health = await call<{ provider_capabilities?: { warning: string | null } }>(
          socket,
          '/v1/health',
        );
        if (health.provider_capabilities?.warning)
          console.error(health.provider_capabilities.warning);
        console.log(JSON.stringify({ socket, service: 'started' }));
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Service did not start; inspect ' + join(state, 'service.log'));
  }
  return false;
}
/** salaam service stop and status. */
export async function serviceCommand(ctx: CliContext): Promise<boolean> {
  const { socket, group, verb } = ctx;
  if (group === 'service' && verb === 'stop') {
    console.log(JSON.stringify(await call(socket, '/v1/shutdown', {})));
    return true;
  }
  if (group === 'service' && verb === 'status') {
    console.log(JSON.stringify(await call(socket, '/v1/health'), null, 2));
    return true;
  }
  return false;
}
