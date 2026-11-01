#!/usr/bin/env node
import { loadDangerClassifierOptions } from './danger-classifier.js';
import { loadWebSearchConfig } from './web-search.js';
import { SANDBOX_LEVELS, type SandboxLevel } from './command-sandbox.js';
import { acp } from './acp.js';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { digest, object } from './protocol.js';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  fsyncSync,
  existsSync,
} from 'node:fs';
import { ROOT, VERSION } from './config.js';
import { cliHelp, hasHelpFlag } from './cli-help.js';
import { mcpCli, MCP_HELP } from './operator-mcp-cli.js';
import { operatorMcpPath, readOperatorMcpFile } from './operator-mcp.js';
import { defaultAgentPodConfig } from './agentpod-default-config.js';
import { SalaamService } from './service.js';
import { call } from './transport.js';
import { attach, acquireControl, Outbox } from './attach.js';
import type { SessionSnapshot, Approval, Operation } from './protocol.js';
import {
  providerRoute,
  PI_PROVIDERS,
  getProvider,
  providerHasOutputCap,
} from './provider-config.js';
import { readSecret, validateApiKey } from './credentials.js';
import {
  authDirectory,
  ProviderCredentialStore,
  providerModels,
  loginProvider,
  resolveProviderAuth,
} from './provider-auth.js';
import { bindProviderConfiguration } from './provider-model.js';
import { createInterface } from 'node:readline/promises';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import { canonical } from './protocol.js';
import { SocketEffectConnector } from './effect-connector.js';
import { proveExecutionBoundary } from './execution-proof.js';
import { BoundaryBroker, engineRequest } from './execution-boundary.js';
import { workspaceDiff, type WorkspaceChange } from './workspace-diff.js';
import {
  probeHarness,
  HARNESS_TARGETS,
  type HarnessPin,
  type HarnessTarget,
} from './harness-probe.js';
interface WorkspaceDiffPage {
  revision: number;
  digest: string;
  changes: WorkspaceChange[];
  next_offset: number | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    console.log('salaam ' + VERSION);
    return;
  }
  if (args[0] === '-c' || args[0] === '--continue') {
    const { continueArgs } = await import('./session-pick.js');
    args.splice(0, args.length, ...continueArgs(args)!);
  }
  if (args[0] === 'mcp') {
    // Parsed before global help: a declared command's own flags follow "--".
    const rest = args.slice(1);
    const dash = rest.indexOf('--');
    const flags = dash < 0 ? rest : rest.slice(0, dash);
    if (!rest.length || flags.includes('--help') || flags.includes('-h')) console.log(MCP_HELP);
    else console.log(mcpCli(rest));
    return;
  }
  if (
    (!args.length && !(process.stdin.isTTY && process.stdout.isTTY)) ||
    args[0] === 'help' ||
    hasHelpFlag(args)
  ) {
    const group = args[0] === 'help' ? args[1] : args[0]?.startsWith('-') ? undefined : args[0];
    const help = cliHelp(group);
    if (!help) {
      console.error('Unknown command. Run salaam --help.');
      process.exitCode = 2;
      return;
    }
    console.log(help);
    return;
  }
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return;
    const value = args[i + 1];
    if (!value) throw new Error(`Missing ${name}`);
    args.splice(i, 2);
    return value;
  };
  const explicitState = option('--state');
  const state = resolve(
    explicitState ?? process.env.SALAAM_STATE_DIR ?? join(homedir(), '.local/state/salaam'),
  );
  const foreground = args.includes('--foreground');
  if (foreground) args.splice(args.indexOf('--foreground'), 1);
  const socket = join(state, 'operator.sock');
  const [group, verb, id] = args;
  if (group === 'a2a' && verb === 'credential') {
    const file = option('--file');
    if (!id || !file) throw Error('Supply PEER_ID and --file NEW_OWNER_ONLY_FILE');
    const { a2aIdentity } = await import('./a2a-peer.js');
    a2aIdentity(id);
    const path = resolve(file),
      value = { peer: id, token: randomBytes(32).toString('base64url') };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.log(
      JSON.stringify(
        { peer: id, file: realpathSync(path), credential_digest: digest(value) },
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'a2a' && verb === 'discover') {
    const peer = option('--peer'),
      endpoint = option('--endpoint'),
      card_url = option('--card-url'),
      credential = option('--credential-file'),
      addresses = option('--addresses');
    if (!peer || !endpoint || !card_url || !credential || !addresses)
      throw Error('Supply --peer, --endpoint, --card-url, --credential-file and --addresses');
    const { privateJSON, validatePeer, A2AHttp } = await import('./a2a-peer.js');
    const credential_file = realpathSync(resolve(credential)),
      value = privateJSON(credential_file);
    const pin = validatePeer({
      id: peer,
      endpoint,
      card_url,
      card_digest: digest(null),
      tenant: option('--tenant') ?? '',
      skill: 'pending-review',
      addresses: addresses.split(','),
      local: args.includes('--local'),
      credential_file,
      credential_digest: digest(value),
      files: [],
      retention: 'unknown',
      cancel: false,
      streaming: false,
    });
    console.log(JSON.stringify(await new A2AHttp(pin).request(card_url), null, 2));
    return;
  }
  if (group === 'a2a' && verb === 'pin') {
    const peer = option('--peer'),
      endpoint = option('--endpoint'),
      cardFile = option('--card-file'),
      credential = option('--credential-file'),
      addresses = option('--addresses'),
      skill = option('--skill');
    if (!peer || !endpoint || !cardFile || !credential || !addresses || !skill)
      throw Error(
        'Supply --peer, --endpoint, --card-file, --credential-file, --addresses and --skill',
      );
    const { privateJSON, validatePeer, A2AHttp } = await import('./a2a-peer.js');
    const card = JSON.parse(readFileSync(resolve(cardFile), 'utf8')),
      credential_file = realpathSync(resolve(credential)),
      value = privateJSON(credential_file),
      card_url = option('--card-url');
    if (!card_url) throw Error('Supply the exact --card-url that was reviewed');
    const pin = validatePeer({
      id: peer,
      endpoint,
      card_url,
      card_digest: digest(card),
      tenant: option('--tenant') ?? '',
      skill,
      addresses: addresses.split(','),
      local: args.includes('--local'),
      credential_file,
      credential_digest: digest(value),
      files: option('--files')?.split(',').filter(Boolean) ?? [],
      retention: option('--retention') ?? 'unknown',
      cancel: args.includes('--supports-cancel'),
      streaming: args.includes('--supports-streaming'),
    });
    new A2AHttp(pin).assertCard(card);
    console.log(JSON.stringify(pin, null, 2));
    return;
  }
  if (group === 'a2a' && verb === 'grant') {
    const assignment = option('--assignment'),
      peer = option('--peer'),
      credential = option('--credential-file');
    if (!assignment || !peer || !credential)
      throw Error('Supply --assignment, --peer and --credential-file');
    const { privateJSON } = await import('./a2a-peer.js');
    const credential_file = realpathSync(resolve(credential)),
      value = object(privateJSON(credential_file));
    if (
      value.peer !== peer ||
      Object.keys(value).sort().join(',') !== 'peer,token' ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9._~-]{32,512}$/.test(value.token)
    )
      throw Error('Use a dedicated peer credential JSON {peer,token}');
    const peerClient = option('--peer-client');
    if (peerClient && peerClient !== 'openclaw-2026.10.5')
      throw Error('Only the explicitly pinned OpenClaw client adapter is available');
    const binding = await call(socket, `/v1/a2a/grants/${encodeURIComponent(assignment)}`);
    console.log(
      JSON.stringify(
        {
          peer,
          tenant: option('--tenant') ?? '',
          skill: option('--skill') ?? 'review',
          assignment_id: assignment,
          binding_digest: digest(binding),
          credential_file,
          credential_digest: digest(value),
          ...(peerClient ? { client: peerClient } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'a2a' && verb === 'peers') {
    console.log(
      JSON.stringify(
        (await call<any[]>(socket, '/v1/harnesses')).filter((r) => r.kind === 'a2a'),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'harness' && verb === 'probe') {
    const path = option('--pin');
    if (!path) throw new Error('Supply an operator-reviewed --pin FILE');
    const pin = JSON.parse(readFileSync(resolve(path), 'utf8')) as HarnessPin;
    console.log(JSON.stringify(await probeHarness(pin), null, 2));
    return;
  }
  if (group === 'harness' && verb === 'prepare') {
    const path = option('--runtime-root'),
      arch = option('--arch');
    if (!path || !arch) throw Error('Supply a new --runtime-root and execution-host --arch');
    const { prepareHarnessRuntime } = await import('./harness-prepare.js');
    console.log(JSON.stringify(await prepareHarnessRuntime(path, arch), null, 2));
    return;
  }
  if (group === 'harness' && verb === 'config') {
    const target = option('--target'),
      path = option('--runtime-root');
    if (!target || !Object.hasOwn(HARNESS_TARGETS, target) || !path)
      throw Error('Supply a named --target and dedicated --runtime-root');
    const runtime_root = realpathSync(resolve(path));
    const { assertHarnessArtifactRoot, harnessRuntimeDigest } =
      await import('./harness-backend.js');
    assertHarnessArtifactRoot(runtime_root);
    console.log(
      JSON.stringify(
        {
          schema: 1,
          runtimes: [
            {
              id: option('--id') ?? target,
              target,
              version: HARNESS_TARGETS[target as HarnessTarget].version,
              runtime_root,
              runtime_digest: await harnessRuntimeDigest(runtime_root),
              model: 'claude-sonnet-4-6',
              output: 4096,
              requests: 12,
            },
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    ['harness', 'a2a'].includes(group ?? '') &&
    ['list', 'inspect', 'reconcile'].includes(verb ?? '')
  ) {
    if (verb === 'list') {
      console.log(JSON.stringify(await call(socket, '/v1/harnesses'), null, 2));
      return;
    }
    if (!id) throw Error('Supply an external CHILD_ID');
    const current = await call<any>(socket, `/v1/harnesses/${id}`);
    if (verb === 'inspect') {
      console.log(JSON.stringify(current, null, 2));
      return;
    }
    const run_id = option('--run-id');
    if (!run_id) throw Error('Supply the exact --run-id from harness inspect');
    const client_id = randomUUID(),
      owner = current.child.parent_session,
      lease = await acquireControl(socket, owner, client_id, args.includes('--takeover'));
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/harnesses/${id}/reconcile`, {
            client_id,
            token: lease.token,
            run_id,
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${owner}/control`, {
        request_id: randomUUID(),
        client_id,
        token: lease.token,
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'workers') {
    if (!id) throw new Error('Supply a child or integration receipt ID');
    if (verb === 'proposal' || verb === 'integration') {
      const result = await call<any>(
        socket,
        verb === 'proposal'
          ? `/v1/workers/${id}/proposal?offset=${Number(option('--offset') ?? 0)}`
          : `/v1/integrations/${id}`,
      );
      if (verb === 'proposal' && !args.includes('--json')) {
        const { changes, diff, ...metadata } = result;
        console.log(
          JSON.stringify(
            {
              ...metadata,
              files: changes.map((c: any) => ({
                path: c.path,
                before_hash: digest(c.before),
                after_hash: digest(c.after),
              })),
            },
            null,
            2,
          ),
        );
        for (const patch of diff) console.log(patch);
      } else console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!['integrate', 'resolve'].includes(verb ?? ''))
      throw new Error('Use workers proposal, integrate, integration or resolve');
    const owner =
      verb === 'integrate'
        ? (await call<{ parent_session: string }>(socket, `/v1/children/${id}`)).parent_session
        : (await call<{ parent_session: string }>(socket, `/v1/integrations/${id}`)).parent_session;
    const revision = option('--revision'),
      workspace_digest = option('--root-digest'),
      patch_digest = option('--patch-digest');
    if (revision === undefined || !workspace_digest || (verb === 'integrate' && !patch_digest))
      throw new Error(
        'Supply reviewed --revision N, --root-digest SHA256 and --patch-digest SHA256 for integration',
      );
    const client_id = randomUUID(),
      lease = await acquireControl(socket, owner, client_id, args.includes('--takeover'));
    try {
      const result = await call(
        socket,
        verb === 'integrate' ? `/v1/workers/${id}/integrate` : `/v1/integrations/${id}/resolve`,
        {
          client_id,
          token: lease.token,
          request_id: option('--request-id') ?? randomUUID(),
          workspace_revision: Number(revision),
          workspace_digest,
          patch_digest,
        },
      );
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await call(socket, `/v1/sessions/${owner}/control`, {
        request_id: randomUUID(),
        client_id,
        token: lease.token,
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'team') {
    if (!id) throw new Error('Supply TASK_ID');
    if (verb === 'show') {
      console.log(JSON.stringify(await call(socket, `/v1/tasks/${id}/team`), null, 2));
      return;
    }
    if (!['assign', 'run', 'reject', 'send', 'receive', 'ack'].includes(verb ?? ''))
      throw new Error('Use team show, assign, run, send, receive or ack');
    const task = await call<{ session_id: string }>(socket, `/v1/tasks/${id}`);
    const client_id = randomUUID(),
      lease = await acquireControl(socket, task.session_id, client_id, args.includes('--takeover'));
    try {
      const assignment = option('--assignment');
      if (['run', 'reject', 'receive', 'ack'].includes(verb!) && !assignment)
        throw new Error('Supply --assignment ID');
      const revision = option('--revision'),
        generation = option('--generation');
      if (['assign', 'run', 'reject'].includes(verb!) && revision === undefined)
        throw new Error('Supply the reviewed --revision N');
      if (['run', 'reject'].includes(verb!) && generation === undefined)
        throw new Error('Supply the reviewed --generation N');
      const path = assignment ? `${assignment}/${verb}` : verb;
      const result = await call(socket, `/v1/tasks/${id}/team/${path}`, {
        client_id,
        token: lease.token,
        request_id: option('--request-id') ?? randomUUID(),
        expected_revision: revision === undefined ? undefined : Number(revision),
        generation: generation === undefined ? undefined : Number(generation),
        ...(verb === 'assign'
          ? {
              step_id: option('--step'),
              profile_id: option('--profile'),
              ...(() => {
                const runtime = option('--runtime');
                return runtime
                  ? { runtime, invocations: Number(option('--invocations')) }
                  : { requests: Number(option('--requests')) };
              })(),
            }
          : {}),
        ...(verb === 'run'
          ? { instruction: option('--instruction'), continues_attempt_id: option('--continues') }
          : {}),
        ...(verb === 'send' ? { recipient: option('--to'), text: option('--text') } : {}),
        ...(verb === 'ack' ? { message_id: option('--message') } : {}),
        ...(verb === 'reject' ? { reason: option('--reason') } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await call(socket, `/v1/sessions/${task.session_id}/control`, {
        request_id: randomUUID(),
        client_id,
        token: lease.token,
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'agents') {
    const session = option('--session');
    if (!session) throw new Error('Supply --session SESSION_ID');
    if (verb === 'list' || verb === 'inspect') {
      console.log(
        JSON.stringify(
          await call(
            socket,
            `/v1/sessions/${session}/agents${verb === 'inspect' ? '?profile=' + encodeURIComponent(id ?? '') : ''}`,
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (!id || !['admit', 'revoke'].includes(verb ?? ''))
      throw new Error('Use agents list, inspect, admit or revoke');
    const client_id = randomUUID(),
      lease = await acquireControl(socket, session, client_id, args.includes('--takeover'));
    try {
      const expected_digest = option('--digest');
      if (verb === 'admit' && !expected_digest)
        throw new Error('Review agents inspect and supply --digest SHA256');
      const fact_ids = option('--facts')?.split(',').filter(Boolean) ?? [];
      const result = await call(socket, `/v1/sessions/${session}/agents/${verb}`, {
        request_id: option('--request-id') ?? randomUUID(),
        client_id,
        token: lease.token,
        ...(verb === 'admit' ? { profile_id: id, expected_digest, fact_ids } : { grant_id: id }),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await call(socket, `/v1/sessions/${session}/control`, {
        request_id: randomUUID(),
        client_id,
        token: lease.token,
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'host') {
    const {
      planHost,
      readHost,
      hostUnit,
      runHost,
      hostReceipt,
      hostToolsUser,
      hostApprovalTtlMs,
      hostAllowsUnsandboxed,
      hostAllowsFullAccessSessions,
      hostAllowsYoloSessions,
      hostDangerClassifier,
      hostCommandNetwork,
      hostReadPaths,
    } = await import('./host.js');
    if (verb?.startsWith('config-')) {
      const file = option('--manifest');
      if (!file) throw Error('Supply --manifest FILE');
      const { hostConfiguration } = await import('./host-configuration.js');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > 65536) throw Error('Configuration request exceeds limit');
        chunks.push(data);
      }
      console.log(
        JSON.stringify(
          await hostConfiguration(
            resolve(file),
            verb.slice(7),
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          ),
        ),
      );
      return;
    }
    if (verb === 'plan') {
      const file = option('--config');
      if (!file) throw new Error('Supply --config FILE');
      console.log(
        JSON.stringify(await planHost(JSON.parse(readFileSync(resolve(file), 'utf8'))), null, 2),
      );
      return;
    }
    if (verb === 'bind') {
      const { bindHost } = await import('./host-bind.js');
      const required = (name: string) => {
        const v = option(name);
        if (!v) throw new Error('Supply ' + name);
        return v;
      };
      console.log(
        JSON.stringify(
          await bindHost({
            organization_id: required('--organization'),
            node_id: required('--node'),
            station_key: required('--station-key'),
            workspace: required('--workspace'),
            tools_user: required('--tools-user'),
            files: required('--files'),
            runtime_root: required('--runtime-root'),
            runtime_image_digest: required('--runtime-image-digest'),
            operator_group: option('--operator-group'),
            dir: option('--dir'),
            state: explicitState ? state : undefined,
            provider: option('--provider'),
            model: option('--model'),
            mcp_config: option('--mcp-config'),
            persona: option('--persona'),
            managed_mcp_config: option('--managed-mcp-config'),
          }),
        ),
      );
      return;
    }
    if (verb === 'unit-start') {
      const { startHostUnit } = await import('./host-start.js');
      const unit = option('--unit');
      if (!unit || !explicitState) throw new Error('Supply --unit UNIT and --state DIR');
      console.log(JSON.stringify(await startHostUnit(unit, state)));
      return;
    }
    const file = option('--manifest');
    if (!file) throw new Error('Supply --manifest FILE');
    if (verb === 'inspect') {
      const m = readHost(file);
      let supervisor: unknown = null;
      try {
        supervisor = JSON.parse(readFileSync(join(m.state, 'host/status.json'), 'utf8'));
      } catch {}
      console.log(
        JSON.stringify(
          {
            manifest: m,
            supervisor,
            health: await call(join(m.state, 'operator.sock'), '/v1/health').catch((error) => ({
              service: 'unavailable',
              error: error.message,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (verb === 'unit') {
      console.log(
        hostUnit(
          file,
          option('--platform') ?? (process.platform === 'darwin' ? 'launchd' : 'systemd'),
        ),
      );
      return;
    }
    if (verb === 'run') {
      await runHost(file);
      return;
    }
    if (verb === 'start') {
      const { startHost } = await import('./host-start.js');
      console.log(JSON.stringify(await startHost(file)));
      return;
    }
    if (verb === 'serve') {
      const m = readHost(file),
        service = await SalaamService.open({
          stateDir: m.state,
          ...(m.schema === 1
            ? { codingRoot: m.coding_root, codingSocket: m.coding_socket, expectedExecution: m }
            : {
                agentpodConfig: m.agentpod_config,
                ...((m.schema === 3 || m.schema === 4 || m.schema === 5 || m.schema === 6) &&
                m.managed_mcp
                  ? { managedMcp: m.managed_mcp }
                  : {}),
                ...((m.schema === 4 || m.schema === 5 || m.schema === 6) && m.managed_toolkit
                  ? { managedToolkitConfig: m.managed_toolkit }
                  : {}),
                ...(m.schema === 5 || m.schema === 6 ? { stationConfig: m.station_execution } : {}),
                ...(m.schema === 6 ? { agentpodWorkProgression: true } : {}),
                ...(m.schema === 6 && m.operator_access
                  ? { operatorAccess: m.operator_access }
                  : {}),
                ...(m.schema === 6 && m.operator_mcp
                  ? { operatorMcpConfig: m.operator_mcp.config }
                  : {}),
                ...(m.schema === 6 && m.persona ? { personaConfig: m.persona } : {}),
              }),
          hostManifestDigest: digest(m),
          hostReceipt: hostReceipt(m),
          toolsUser: hostToolsUser(m),
          providerRoute: m.provider,
          approvalTtlMs: hostApprovalTtlMs(m),
          ...(hostAllowsUnsandboxed(m) ? { unsandboxedCommands: 'allow' as const } : {}),
          // A host session may choose full access only when the reviewed manifest says so.
          allowFullAccessSessions: hostAllowsFullAccessSessions(m),
          allowYoloSessions: hostAllowsYoloSessions(m),
          // The command reviewer only as the reviewed manifest names it (forbidden when absent).
          ...(hostDangerClassifier(m).config
            ? { dangerClassifierConfig: hostDangerClassifier(m).config }
            : {}),
          ...(hostDangerClassifier(m).pin
            ? { dangerClassifierPin: hostDangerClassifier(m).pin }
            : {}),
          ...(hostCommandNetwork(m) ? { commandNetwork: hostCommandNetwork(m)! } : {}),
          ...(hostReadPaths(m).length ? { localSandboxReadPaths: hostReadPaths(m) } : {}),
        });
      if (process.connected) process.once('disconnect', () => void service.close());
      for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.once(signal, () => void service.close());
      await service.closed;
      if (process.connected) process.disconnect?.();
      return;
    }
    throw new Error('Use host plan, start, unit, run or inspect');
  }
  if (group === 'remote' && verb) {
    const { remote } = await import('./remote.js');
    const theme = option('--theme');
    if (theme && !['night', 'paper'].includes(theme))
      throw new Error('Choose --theme night or paper.');
    await remote({
      host: verb,
      executable: option('--remote-bin'),
      state: explicitState,
      session: option('--session'),
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
      theme: theme as 'night' | 'paper' | undefined,
    });
    return;
  }
  if (group === 'code' || group === 'here') {
    const { parseCodeStart } = await import('./session-pick.js');
    const start = parseCodeStart(args.slice(1));
    const { tui } = await import('./tui.js');
    await tui({
      state,
      start,
      cwd: option('--cwd'),
      takeover: args.includes('--takeover'),
      codingRoot: option('--coding-root'),
      codingSocket: option('--coding-socket'),
    });
    return;
  }
  if (
    !group ||
    group === 'tui' ||
    [
      '--session',
      '--observe',
      '--takeover',
      '--theme',
      '--cwd',
      '--coding-root',
      '--coding-socket',
    ].includes(group)
  ) {
    const { tui } = await import('./tui.js');
    const theme = option('--theme');
    if (theme && !['night', 'paper'].includes(theme))
      throw new Error('Choose --theme night or paper.');
    await tui({
      state,
      session: option('--session'),
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
      theme: theme as 'night' | 'paper' | undefined,
      cwd: option('--cwd'),
      codingRoot: option('--coding-root'),
      codingSocket: option('--coding-socket'),
    });
    return;
  }
  if (group === 'workspace' && id && ['inspect', 'diff', 'refresh'].includes(verb ?? '')) {
    if (verb === 'inspect') {
      console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/workspace`), null, 2));
      return;
    }
    if (verb === 'diff') {
      let offset: number | null = 0,
        identity: string | undefined;
      while (offset !== null) {
        const page: WorkspaceDiffPage = await call<WorkspaceDiffPage>(
          socket,
          `/v1/sessions/${id}/workspace/diff?offset=${offset}`,
        );
        const nextIdentity = `${page.revision}:${page.digest}`;
        if (identity && identity !== nextIdentity)
          throw new Error('Workspace changed while reading diff');
        identity = nextIdentity;
        for (const file of page.changes) {
          process.stdout.write(workspaceDiff(file));
        }
        offset = page.next_offset;
      }
      return;
    }
    const expected = Number(option('--revision')),
      reviewed = option('--digest');
    if (!Number.isSafeInteger(expected) || !reviewed)
      throw new Error('Supply reviewed --revision and --digest');
    const client = randomUUID(),
      lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/sessions/${id}/workspace/refresh`, {
            request_id: option('--request-id') ?? randomUUID(),
            expected_revision: expected,
            digest: reviewed,
            client_id: client,
            token: lease.token,
          }),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        request_id: randomUUID(),
        action: 'release',
        client_id: client,
        token: lease.token,
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (
    group === 'commands' &&
    id &&
    ['list', 'inspect', 'logs', 'start', 'cancel', 'reconcile'].includes(verb ?? '')
  ) {
    const run = option('--run-id');
    if (['list', 'inspect', 'logs'].includes(verb!)) {
      if (verb !== 'list' && !run) throw new Error('Supply --run-id');
      const path =
        `/v1/sessions/${id}/commands` +
        (verb === 'list' ? '?summary=1' : `/${run}`) +
        (verb === 'logs' ? `/logs?offset=${Number(option('--offset') ?? 0)}` : '');
      console.log(JSON.stringify(await call(socket, path), null, 2));
      return;
    }
    if (verb !== 'start' && !run) throw new Error('Supply --run-id');
    const body =
      verb === 'start'
        ? {
            step_key: option('--step-key'),
            command: option('--command'),
            cwd: option('--cwd') ?? '.',
            expected_revision: Number(option('--revision')),
          }
        : { request_id: option('--request-id') ?? randomUUID() };
    const client = randomUUID(),
      lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    try {
      console.log(
        JSON.stringify(
          await call(
            socket,
            `/v1/sessions/${id}/commands` + (verb === 'start' ? '' : `/${run}/${verb}`),
            { ...body, client_id: client, token: lease.token },
          ),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        request_id: randomUUID(),
        action: 'release',
        client_id: client,
        token: lease.token,
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'execution' && ['prove', 'cleanup'].includes(verb ?? '')) {
    const dockerSocket = option('--docker-socket');
    if (!dockerSocket) throw new Error('Supply an explicit local --docker-socket PATH');
    if (verb === 'cleanup') {
      const run = option('--run-id');
      if (!run) throw new Error('Supply the saved proof --run-id UUID');
      const removed = await new BoundaryBroker(run, engineRequest(dockerSocket)).cleanup();
      console.log(JSON.stringify({ removed, cleanup_confirmed: true }));
    } else {
      const scratchRoot = option('--scratch-root');
      const report = option('--report');
      if (!scratchRoot || !report) throw new Error('Supply --scratch-root DIR and --report PATH');
      const passed = await proveExecutionBoundary({ socket: dockerSocket, scratchRoot, report });
      console.log(JSON.stringify({ passed, report: resolve(report), coding_tools_enabled: false }));
      if (!passed) process.exitCode = 1;
    }
    return;
  }
  if (group === 'acp') {
    await acp(state, { coding: args.includes('--coding') });
    return;
  }
  if (group === 'providers' && verb === 'list') {
    console.log(
      JSON.stringify(
        PI_PROVIDERS.map((p) => ({
          id: p.id,
          name: p.name,
          chat_models: p.getModels().length,
          apis: [...new Set(p.getModels().map((m) => m.api))],
          auth: [p.auth.apiKey ? 'api_key' : null, p.auth.oauth ? 'oauth' : null].filter(Boolean),
          limitation: !p.getModels().length
            ? 'Classifier only; no chat route'
            : p.id === 'openai-codex'
              ? 'No provider-enforced output cap; tasks must explicitly disable token budgeting'
              : null,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'models' && verb === 'list') {
    const providers = id ? [getProvider(id)] : PI_PROVIDERS;
    if (providers.some((p) => !p)) throw new Error('Unknown Pi provider');
    console.log(
      JSON.stringify(
        providers.flatMap((p) =>
          p!.getModels().map((m) => ({
            provider: p!.id,
            id: m.id,
            name: m.name,
            api: m.api,
            context_window: m.contextWindow,
            max_output_tokens: m.maxTokens,
          })),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'auth') {
    const store = new ProviderCredentialStore();
    if (verb === 'status') {
      const models = providerModels(store),
        entries = id ? [getProvider(id)] : PI_PROVIDERS;
      if (entries.some((p) => !p)) throw new Error('Unknown Pi provider');
      const statuses = [];
      for (const p of entries) {
        try {
          const auth = await models.checkAuth(p!.id);
          statuses.push({
            provider: p!.id,
            configured: !!auth,
            type: auth?.type ?? null,
            source: auth?.source ?? null,
          });
        } catch {
          statuses.push({ provider: p!.id, configured: false, error: 'Credential check failed' });
        }
      }
      console.log(JSON.stringify(statuses, null, 2));
      return;
    }
    if (!id || !getProvider(id)) throw new Error('Choose a provider from salaam providers list');
    if (verb === 'logout') {
      await store.delete(id);
      console.log(
        'Stored credential removed for ' + id + '. Environment credentials remain external.',
      );
      return;
    }
    if (verb === 'set') {
      if (!getProvider(id)!.auth.apiKey)
        throw new Error('This provider needs salaam auth login ' + id + ' --oauth');
      const key = (await readSecret(id + ' API key (hidden): ')).trim();
      if (
        !key ||
        key.length > 4096 ||
        /[^\x21-\x7e]/.test(key) ||
        (id === 'anthropic' && key.includes('sk-ant-oat'))
      )
        throw new Error('Supply a provider API key, not an OAuth token');
      if (id === 'anthropic') validateApiKey(key);
      await store.modify(id, async () => ({ type: 'api_key', key }));
      console.log(
        'API key saved privately for ' + id + ' under ' + authDirectory() + ' (mode 600).',
      );
      return;
    }
    if (verb === 'login') {
      if (!process.stdin.isTTY)
        throw new Error(
          'Interactive login needs a terminal; use auth set PROVIDER for a piped API key',
        );
      const provider = getProvider(id)!;
      const type = args.includes('--oauth') || !provider.auth.apiKey ? 'oauth' : 'api_key';
      const interaction: AuthInteraction = {
        async prompt(prompt) {
          if (prompt.type === 'secret')
            return readSecret(prompt.message + ' (hidden): ', prompt.signal);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const choices =
              prompt.type === 'select'
                ? '\n' + prompt.options.map((v, i) => `${i + 1}. ${v.label} (${v.id})`).join('\n')
                : '';
            const answer = await rl.question(prompt.message + choices + '\n> ', {
              signal: prompt.signal,
            });
            return prompt.type === 'select' && /^\d+$/.test(answer)
              ? (prompt.options[Number(answer) - 1]?.id ?? answer)
              : answer;
          } finally {
            rl.close();
          }
        },
        notify(event) {
          if (event.type === 'auth_url')
            console.error(
              'Open in your browser: ' +
                event.url +
                (event.instructions ? '\n' + event.instructions : ''),
            );
          else if (event.type === 'device_code')
            console.error('Open ' + event.verificationUri + ' and enter ' + event.userCode);
          else console.error(event.message);
        },
      };
      await loginProvider(id, type, interaction);
      console.log(
        'Signed in to ' +
          id +
          ' with ' +
          type +
          '. Restart the service to use a different provider route.',
      );
      return;
    }
    throw new Error('Run salaam auth --help');
  }
  if (group === 'schedules' && verb) {
    if (verb === 'list' || (id && ['inspect', 'occurrences'].includes(verb))) {
      console.log(
        JSON.stringify(
          await call(
            socket,
            verb === 'list'
              ? '/v1/schedules?offset=' + (option('--offset') ?? '0')
              : `/v1/schedules/${id}` +
                  (verb === 'occurrences'
                    ? '/occurrences?offset=' + (option('--offset') ?? '0')
                    : ''),
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (id && ['create', 'update', 'run'].includes(verb)) {
      const revision = Number(option('--revision'));
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error('Supply reviewed --revision');
      const target = await call<{ session_id: string }>(
        socket,
        verb === 'create' ? `/v1/tasks/${id}` : `/v1/schedules/${id}`,
      );
      const client_id = randomUUID(),
        lease = await acquireControl(
          socket,
          target.session_id,
          client_id,
          args.includes('--takeover'),
        );
      try {
        const file = option('--schedule');
        const body = {
          client_id,
          token: lease.token,
          request_id: option('--request-id') ?? randomUUID(),
          expected_revision: revision,
          ...(verb === 'run'
            ? { occurrence_key: option('--key') }
            : verb === 'create'
              ? {
                  task_id: id,
                  name: option('--name'),
                  max_steps: Number(option('--max-steps')),
                  compact: args.includes('--compact'),
                  schedule: file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : null,
                }
              : {
                  schedule: file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : null,
                  state: option('--status'),
                }),
        };
        console.log(
          JSON.stringify(
            await call(
              socket,
              verb === 'create' ? '/v1/schedules' : `/v1/schedules/${id}/${verb}`,
              body,
            ),
            null,
            2,
          ),
        );
      } finally {
        await call(socket, `/v1/sessions/${target.session_id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id,
          token: lease.token,
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return;
    }
  }
  if (group === 'inbox' && verb) {
    if (verb === 'list' || (verb === 'inspect' && id)) {
      console.log(
        JSON.stringify(
          await call(
            socket,
            verb === 'list' ? '/v1/inbox?offset=' + (option('--offset') ?? '0') : `/v1/inbox/${id}`,
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (verb === 'ack' && id) {
      const entry = await call<{ session_id: string }>(socket, `/v1/inbox/${id}`),
        client_id = randomUUID(),
        lease = await acquireControl(
          socket,
          entry.session_id,
          client_id,
          args.includes('--takeover'),
        );
      try {
        console.log(
          JSON.stringify(
            await call(socket, `/v1/inbox/${id}/ack`, {
              client_id,
              token: lease.token,
              request_id: option('--request-id') ?? randomUUID(),
              expected_revision: Number(option('--revision')),
            }),
            null,
            2,
          ),
        );
      } finally {
        await call(socket, `/v1/sessions/${entry.session_id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id,
          token: lease.token,
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return;
    }
  }
  if (group === 'jobs' && verb) {
    if (verb === 'list') {
      console.log(
        JSON.stringify(
          await call(socket, '/v1/jobs?offset=' + encodeURIComponent(option('--offset') ?? '0')),
          null,
          2,
        ),
      );
      return;
    }
    if (id && ['inspect', 'occurrence'].includes(verb)) {
      console.log(
        JSON.stringify(
          await call(socket, verb === 'inspect' ? `/v1/jobs/${id}` : `/v1/job-occurrences/${id}`),
          null,
          2,
        ),
      );
      return;
    }
    if (id && ['create', 'run', 'cancel'].includes(verb)) {
      const expected = Number(option('--revision'));
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new Error('Supply the reviewed --revision');
      const target = await call<{ session_id: string }>(
        socket,
        verb === 'create' ? `/v1/tasks/${id}` : `/v1/jobs/${id}`,
      );
      const client_id = randomUUID(),
        lease = await acquireControl(
          socket,
          target.session_id,
          client_id,
          args.includes('--takeover'),
        );
      try {
        const body = {
          request_id: option('--request-id') ?? randomUUID(),
          expected_revision: expected,
          client_id,
          token: lease.token,
          ...(verb === 'create'
            ? {
                task_id: id,
                name: option('--name'),
                max_steps: Number(option('--max-steps')),
                compact: args.includes('--compact'),
              }
            : verb === 'run'
              ? { occurrence_key: option('--key') }
              : {}),
        };
        console.log(
          JSON.stringify(
            await call(socket, verb === 'create' ? '/v1/jobs' : `/v1/jobs/${id}/${verb}`, body),
            null,
            2,
          ),
        );
      } finally {
        await call(socket, `/v1/sessions/${target.session_id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id,
          token: lease.token,
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return;
    }
  }
  if (group === 'tasks' && verb && id) {
    if (['inspect', 'history', 'current', 'checkpoints', 'restores'].includes(verb)) {
      const path =
        verb === 'current'
          ? `/v1/tasks?session_id=${encodeURIComponent(id)}`
          : `/v1/tasks/${id}${verb === 'history' ? '/history?offset=' + encodeURIComponent(option('--offset') ?? '0') : ['checkpoints', 'restores'].includes(verb) ? '/' + verb : ''}`;
      console.log(JSON.stringify(await call(socket, path), null, 2));
      return;
    }
    if (
      [
        'create',
        'revise',
        'run',
        'complete',
        'verify',
        'finish',
        'checkpoint',
        'restore',
        'auto',
        'pause',
        'cancel',
      ].includes(verb)
    ) {
      const expected = Number(option('--revision'));
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new Error('Supply the reviewed --revision');
      const task =
        verb === 'create'
          ? undefined
          : await call<{ session_id: string }>(socket, `/v1/tasks/${id}`);
      const session = task?.session_id ?? id;
      const client_id = randomUUID();
      const lease = await acquireControl(socket, session, client_id, args.includes('--takeover'));
      try {
        const body: Record<string, unknown> = {
          request_id: option('--request-id') ?? randomUUID(),
          expected_revision: expected,
          client_id,
          token: lease.token,
        };
        let path = '/v1/tasks';
        if (verb === 'create' || verb === 'revise') {
          const file = option('--plan');
          if (!file)
            throw new Error('Supply --plan FILE containing objective, constraints and steps');
          body.plan = JSON.parse(readFileSync(resolve(file), 'utf8'));
          if (verb === 'create') body.session_id = id;
          else path += `/${id}/revise`;
        } else if (
          ['verify', 'finish', 'checkpoint', 'restore', 'auto', 'pause', 'cancel'].includes(verb)
        ) {
          path += `/${id}/${verb === 'pause' ? 'auto' : verb}`;
          if (verb === 'verify') {
            body.check_key = option('--check');
            body.step_id = option('--step') ?? null;
          }
          if (verb === 'finish') {
            const reason = option('--exception-reason'),
              evidence = option('--evidence-artifact');
            if (reason || evidence) {
              if (!reason || !evidence)
                throw new Error('Supply both --exception-reason and --evidence-artifact');
              body.exception = { reason, evidence_artifact: evidence };
            }
          }
          if (verb === 'restore') {
            body.checkpoint_id = option('--checkpoint');
            body.workspace_revision = Number(option('--workspace-revision'));
            body.workspace_digest = option('--workspace-digest');
          }
          if (verb === 'auto' || verb === 'pause') {
            body.max_steps = verb === 'pause' ? 0 : Number(option('--max-steps'));
            body.compact = args.includes('--compact');
          }
        } else {
          const step = option('--step');
          if (!step) throw new Error('Supply the reviewed --step ID');
          path += `/${id}/steps/${step}/${verb}`;
          if (verb === 'complete') {
            body.review = option('--review');
            if (!body.review)
              throw new Error('Supply --review TEXT recording the operator decision');
          } else {
            body.instruction = option('--text') ?? null;
            body.continues_attempt_id = option('--continue-attempt') ?? null;
          }
        }
        console.log(JSON.stringify(await call(socket, path, body), null, 2));
      } finally {
        await call(socket, `/v1/sessions/${session}/control`, {
          request_id: randomUUID(),
          client_id,
          token: lease.token,
          action: 'release',
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return;
    }
  }
  if (group === 'task' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/task`), null, 2));
    return;
  }
  if (group === 'history' && verb === 'read' && id) {
    const query = new URLSearchParams();
    for (const key of ['artifact-id', 'entry-id', 'offset']) {
      const value = option('--' + key);
      if (value !== undefined) query.set(key.replace('-', '_'), value);
    }
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/history?${query}`), null, 2));
    return;
  }
  if (
    (group === 'task' && verb === 'update' && id) ||
    (group === 'session' && verb === 'compact' && id) ||
    (group === 'compactions' && verb === 'cancel' && id) ||
    (group === 'artifacts' && verb === 'put' && id)
  ) {
    const work =
      group === 'compactions'
        ? await call<{ session_id: string }>(socket, `/v1/compactions/${id}`)
        : null;
    const session = work?.session_id ?? id!;
    const client_id = randomUUID();
    const lease = await acquireControl(socket, session, client_id, args.includes('--takeover'));
    const request_id = option('--request-id') ?? randomUUID();
    try {
      const expected = Number(option('--task-version'));
      const fact =
        group === 'task'
          ? {
              kind: option('--kind'),
              text: option('--text'),
              supersedes: option('--supersedes'),
              artifact_id: option('--artifact-id'),
            }
          : undefined;
      if (
        !['compactions', 'artifacts'].includes(group!) &&
        (!Number.isSafeInteger(expected) || expected < 0)
      )
        throw new Error('Supply the reviewed --task-version from task inspect');
      console.log(JSON.stringify({ request_id }));
      console.log(
        JSON.stringify(
          await call(
            socket,
            group === 'compactions'
              ? `/v1/compactions/${id}/cancel`
              : `/v1/sessions/${session}/${group === 'task' ? 'task' : group === 'artifacts' ? 'artifacts' : 'compact'}`,
            {
              request_id,
              expected_version: expected,
              fact,
              ...(group === 'artifacts' ? { text: option('--text') } : {}),
              client_id,
              token: lease.token,
            },
          ),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${session}/control`, {
        request_id: randomUUID(),
        action: 'release',
        client_id,
        token: lease.token,
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'compactions' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/compactions/${id}`), null, 2));
    return;
  }
  if (group === 'session' && id && (verb === 'children' || verb === 'usage')) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/${verb}`), null, 2));
    return;
  }
  if (group === 'children' && id && ['inspect', 'result', 'ack'].includes(verb ?? '')) {
    if (verb === 'ack') {
      const result_id = option('--result');
      if (!result_id) throw new Error('Supply the result ID with --result');
      console.log(
        JSON.stringify(
          await call(socket, `/v1/children/${id}/ack`, {
            result_id,
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
    } else
      console.log(
        JSON.stringify(
          await call(socket, `/v1/children/${id}${verb === 'result' ? '/result' : ''}`),
          null,
          2,
        ),
      );
    return;
  }
  if (group === 'approvals' && verb === 'list') {
    const session = option('--session');
    console.log(
      JSON.stringify(
        await call(
          socket,
          '/v1/approvals' + (session ? '?session=' + encodeURIComponent(session) : ''),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'approvals' && id && ['inspect', 'approve', 'deny'].includes(verb ?? '')) {
    const approval = await call<Approval>(socket, `/v1/approvals/${id}`);
    if (verb === 'inspect') {
      console.log(
        JSON.stringify(
          { approval, operation: await call(socket, `/v1/operations/${approval.operation_id}`) },
          null,
          2,
        ),
      );
      return;
    }
    const binding = option('--digest');
    const revision = Number(option('--revision'));
    if (!binding || !Number.isSafeInteger(revision))
      throw new Error('Supply the reviewed --digest and --revision from approvals inspect');
    const outbox = new Outbox(state, approval.session_id);
    const record = outbox.enqueueDecision(
      id,
      binding,
      revision,
      verb === 'approve' ? 'approve' : 'deny',
      option('--request-id'),
    );
    console.log(JSON.stringify({ request_id: record.request_id }));
    await outbox.flush(socket, approval.session_id);
    console.log(JSON.stringify(await call(socket, `/v1/approvals/${id}`), null, 2));
    return;
  }
  if (group === 'operations' && id && ['inspect', 'reconcile', 'resolve'].includes(verb ?? '')) {
    if (verb === 'inspect') {
      console.log(JSON.stringify(await call(socket, `/v1/operations/${id}`), null, 2));
      return;
    }
    if (verb === 'reconcile') {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/operations/${id}/reconcile`, {
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
      return;
    }
    const binding = option('--digest');
    const revision = Number(option('--revision'));
    const evidence = option('--evidence');
    const outcome = option('--outcome');
    if (
      !binding ||
      !Number.isSafeInteger(revision) ||
      !evidence ||
      !['succeeded', 'failed_definite'].includes(outcome ?? '')
    )
      throw new Error(
        'Supply reviewed --digest --revision --evidence and --outcome succeeded|failed_definite',
      );
    const request_id = option('--request-id') ?? randomUUID();
    console.log(JSON.stringify({ request_id }));
    console.log(
      JSON.stringify(
        await call(socket, `/v1/operations/${id}/resolution`, {
          request_id,
          expected_revision: revision,
          operation_digest: binding,
          evidence,
          outcome,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'session' && verb === 'revocation' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/revocation`), null, 2));
    return;
  }
  if (group === 'session' && verb === 'revoke' && id) {
    const reason = option('--reason');
    if (!reason) throw new Error('Supply --reason');
    const request_id = option('--request-id') ?? randomUUID();
    const saved = await call<import('./execution-authority.js').SessionRevocation | null>(
      socket,
      `/v1/sessions/${id}/revocation`,
    );
    if (saved?.request_id === request_id && saved.session_id === id) {
      if (saved.reason !== reason) throw new Error('Request ID already binds a different reason');
      console.log(JSON.stringify(saved, null, 2));
      return;
    }
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      console.log(JSON.stringify({ request_id }));
      for (let retry = 0; ; retry++) {
        const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
        try {
          console.log(
            JSON.stringify(
              await call(socket, `/v1/sessions/${id}/revoke`, {
                ...controller,
                request_id,
                expected_revision: snapshot.revision,
                reason,
              }),
              null,
              2,
            ),
          );
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== 'revision_conflict' || retry >= 7) throw error;
        }
      }
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'session' && verb === 'cancel' && id) {
    const attempt = option('--attempt');
    if (!attempt) throw new Error('Supply --attempt');
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
      const outbox = new Outbox(state, id);
      const record = outbox.enqueueCancellation(attempt, snapshot.revision, option('--request-id'));
      console.log(JSON.stringify({ request_id: record.request_id }));
      await outbox.flush(socket, id, controller);
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  if (group === 'attach' && verb) {
    if (process.stdin.isTTY && process.stdout.isTTY && !args.includes('--plain')) {
      const { tui } = await import('./tui.js');
      await tui({
        state,
        session: verb,
        observe: args.includes('--observe'),
        takeover: args.includes('--takeover'),
      });
      return;
    }
    await attach(state, verb, {
      observe: args.includes('--observe'),
      takeover: args.includes('--takeover'),
    });
    return;
  }
  if (group === 'session' && ['submit', 'continue', 'resume'].includes(verb ?? '') && id) {
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      if (verb !== 'resume') {
        const text = option('--text');
        if (!text) throw new Error('Supply --text with a new instruction');
        const continues = verb === 'continue' ? option('--attempt') : undefined;
        if (verb === 'continue' && !continues)
          throw new Error('Supply --attempt with the interrupted attempt ID');
        const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
        const outbox = new Outbox(state, id);
        const pending = outbox.enqueue(text, snapshot.revision, continues);
        await outbox.flush(socket, id, controller);
        console.log(JSON.stringify({ request_id: pending.request_id, accepted: true }));
      }
      console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/resume`, controller)));
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
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
      return;
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
    } catch {}
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
      return;
    }
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const fd = openSync(join(state, 'service.log'), 'a', 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
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
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Service did not start; inspect ' + join(state, 'service.log'));
  }
  if (group === 'service' && verb === 'stop') {
    console.log(JSON.stringify(await call(socket, '/v1/shutdown', {})));
    return;
  }
  if (group === 'service' && verb === 'status') {
    console.log(JSON.stringify(await call(socket, '/v1/health'), null, 2));
    return;
  }
  if (group === 'session' && verb === 'create') {
    const cwd = resolve(option('--cwd') ?? process.cwd());
    const requestId = option('--request-id') ?? randomUUID();
    if (args.includes('--coding')) {
      const health = await call<{ coding_root?: string | null }>(socket, '/v1/health');
      if (!health.coding_root)
        throw new Error(
          'Coding service is not configured; start with --coding-root (and --coding-socket for commands)',
        );
    }
    console.log(
      JSON.stringify(
        await call(socket, '/v1/sessions', {
          cwd,
          request_id: requestId,
          ...(args.includes('--coding') ? { coding: true } : {}),
          ...(args.includes('--local') || args.includes('--local-coding')
            ? {
                local_workspace: true,
                ...(args.includes('--local-coding') ? { local_coding: true } : {}),
                ...(option('--provider')
                  ? {
                      route: {
                        provider: option('--provider'),
                        model: option('--model'),
                        max_tokens: option('--max-output-tokens')
                          ? Number(option('--max-output-tokens'))
                          : undefined,
                      },
                    }
                  : {}),
              }
            : {}),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (group === 'session' && verb === 'list') {
    console.log(JSON.stringify(await call(socket, '/v1/sessions'), null, 2));
    return;
  }
  if (group === 'session' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/snapshot`), null, 2));
    return;
  }
  if (group === 'session' && verb === 'probe' && id) {
    const client_id = randomUUID();
    const lease = await acquireControl(socket, id, client_id, args.includes('--takeover'));
    const controller = { client_id, token: lease.token };
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/sessions/${id}/probe`, controller, undefined, 15000),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return;
  }
  const help = cliHelp(group);
  if (args.length === 1 && help) console.log(help);
  else {
    console.error('Unknown or incomplete command. Run salaam --help.');
    process.exitCode = 2;
  }
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
