import { join, resolve } from 'node:path';
import { digest, call } from '../../core/index.js';
import { readFileSync } from 'node:fs';
import { SalaamService } from '../../service/index.js';
import type { CliContext } from './context.js';

export const HOST_HELP = `salaam host plan --config FILE > host-manifest.json
chmod 600 host-manifest.json
salaam host inspect --manifest host-manifest.json
salaam host unit --manifest host-manifest.json --platform systemd|launchd
salaam host run --manifest host-manifest.json
salaam host start --manifest host-manifest.json
salaam host unit-start --unit salaam-host@STATION.service --state DIR
salaam host bind --organization ORG --node NODE --station-key KEY --workspace DIR \
  --tools-user USER --files HELPER --runtime-root DIR --runtime-image-digest sha256:… \
  [--operator-group GROUP] [--provider P --model M] [--mcp-config FILE] [--persona FILE] [--managed-mcp-config FILE] [--dir DIR] [--state DIR]

Config requires absolute state, coding_root and coding_socket paths; optional
provider, model, max_output_tokens and workspace_id. Planning probes the existing
executor and pins Node, source/build, Pi, provider, profile and engine identity.
Review generated units before installing with your host's service manager. No key
is stored in the manifest: configure it in the service user's credential home.
Run uses an exclusive supervisor lock, durable health, bounded restart/backoff,
and refuses source/build or executor drift before the daemon admits work.

For a bound AgentPod host, use mode="agentpod", state and agentpod_config instead
of coding_root/coding_socket. This profile enables no station tools. The private
manifest pins Node, CLI, source/build, Pi, provider and authority pins. Invoke the
canonical Node executable explicitly. host start waits for matching live health
and safely coalesces concurrent callers; it never installs or upgrades packages.

Launcher profile (Linux): root plans a strict work host with operator_group set.
A root-owned unit runs host run from that root-held manifest. The daemon lets that
one group traverse its state and use operator.sock. An unprivileged member then
runs host unit-start, which asks systemd to start the named salaam-host@ unit and
prints the receipt the running daemon reports. It cannot choose what root runs.

host bind (root, Linux) writes everything a launcher-profile station needs into
--dir (default /etc/salaam/stations/<key>): agentpod-pins.json, station-config.json
(with tools_user), host-config.json, and host.json from host plan. It is
idempotent: the same inputs leave the files and the manifest digest unchanged.`;

/** salaam host: plan, bind, start, supervise and inspect a pinned host. */
export async function hostCommand(ctx: CliContext): Promise<boolean> {
  const { option, state, explicitState, group, verb } = ctx;
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
    } = await import('../../host/host.js');
    if (verb?.startsWith('config-')) {
      const file = option('--manifest');
      if (!file) throw Error('Supply --manifest FILE');
      const { hostConfiguration } = await import('../../host/configuration.js');
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
      return true;
    }
    if (verb === 'plan') {
      const file = option('--config');
      if (!file) throw new Error('Supply --config FILE');
      console.log(
        JSON.stringify(await planHost(JSON.parse(readFileSync(resolve(file), 'utf8'))), null, 2),
      );
      return true;
    }
    if (verb === 'bind') {
      const { bindHost } = await import('../../host/bind.js');
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
      return true;
    }
    if (verb === 'unit-start') {
      const { startHostUnit } = await import('../../host/start.js');
      const unit = option('--unit');
      if (!unit || !explicitState) throw new Error('Supply --unit UNIT and --state DIR');
      console.log(JSON.stringify(await startHostUnit(unit, state)));
      return true;
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
      return true;
    }
    if (verb === 'unit') {
      console.log(
        hostUnit(
          file,
          option('--platform') ?? (process.platform === 'darwin' ? 'launchd' : 'systemd'),
        ),
      );
      return true;
    }
    if (verb === 'run') {
      await runHost(file);
      return true;
    }
    if (verb === 'start') {
      const { startHost } = await import('../../host/start.js');
      console.log(JSON.stringify(await startHost(file)));
      return true;
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
      return true;
    }
    throw new Error('Use host plan, start, unit, run or inspect');
  }
  return false;
}
