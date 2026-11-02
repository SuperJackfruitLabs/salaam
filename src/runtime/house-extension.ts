// The house extension: Pi loads this file inside the worker process (HOUSE_EXTENSION in
// core/config.ts). It registers Salaam's tools, hooks and provider in a fixed order, each part
// from its own file under house/, and proves readiness to the service over the bridge. Every file
// it loads is hashed by bundleDigest and imported directly, never through a module index.
import { registerClaude } from '../providers/claude-provider.js';
import { OFFLINE_ROUTE } from '../core/provider-route.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  PROTOCOL_VERSION,
  workerTools,
  workerCapabilities,
  textDigest,
  digest,
} from '../core/protocol.js';
import { workerBridge, type House, type WorkerConfig } from './house/context.js';
import { registerManagedTool, registerProbe } from './house/managed.js';
import { registerStationTools } from './house/station.js';
import { registerIntegrationTools } from './house/integrations.js';
import { registerChildTools } from './house/children.js';
import { registerSpecialistTools } from './house/specialists.js';
import { registerDeskTools } from './house/desk.js';
import { registerPromptHooks } from './house/prompts.js';
import { registerCodingTools } from './house/coding.js';
import {
  registerCompaction,
  registerContext,
  registerHistory,
  registerPolicyGate,
} from './house/turn.js';
import { registerProofProvider } from './house/proof-provider.js';

/** How often a ready worker tells the service it is alive. */
const HEARTBEAT_INTERVAL = 500;

export default function house(pi: ExtensionAPI): void {
  const config = JSON.parse(process.env.SALAAM_WORKER_CONFIG ?? 'null') as WorkerConfig | null;
  if (!config) throw new Error('Missing Salaam worker configuration');
  const c = config;
  const route = c.route ?? { ...OFFLINE_ROUTE };
  const bridge = workerBridge(c);
  let timer: NodeJS.Timeout | undefined;
  let shutdown: (() => void) | undefined;
  const fail = async () => {
    try {
      await bridge('failure', { reason: 'Required extension or bridge failed' });
    } catch {
      /* supervisor also detects bridge loss */
    }
    shutdown?.();
  };
  const h: House = { pi, c, bridge, fail };
  // The order below is the order Pi sees the tools and hooks; house-registration.test.ts pins it.
  registerProbe(h);
  registerStationTools(h);
  registerIntegrationTools(h);
  if (!c.child && !c.local) {
    registerChildTools(h);
    registerManagedTool(h, 'salaam_review', 'review');
  }
  if (c.effects) registerManagedTool(h, 'salaam_effect', 'effect');
  registerSpecialistTools(h);
  registerDeskTools(h);
  registerPromptHooks(h);
  registerCodingTools(h);
  registerPolicyGate(h);
  registerHistory(h);
  registerCompaction(h);
  registerContext(h);
  if (route.provider !== 'salaam-proof')
    registerClaude(
      pi,
      route,
      () => c.frame,
      workerTools(
        !!c.effects,
        !!c.child,
        c.coding,
        c.worker_binding?.binding.tools,
        !!c.mcp && !c.child,
        !!c.toolkit && !c.child,
        !!c.station && !c.child,
        !!c.local,
        !!c.localCoding,
        !!c.operator_mcp?.length && !c.child,
      ),
      bridge,
      fail,
    );
  else registerProofProvider(h);
  pi.on('session_start', async (_event, ctx) => {
    shutdown = () => ctx.shutdown();
    await bridge('handshake', {
      protocol_version: PROTOCOL_VERSION,
      bundle_digest: c.bundle,
      policy_digest: c.policy,
      session_id: c.session,
      epoch: c.epoch,
      pi_session_id: ctx.sessionManager.getSessionId(),
      capabilities: workerCapabilities(
        c.coding,
        c.child
          ? c.worker_binding?.binding.tools
          : [
              ...(c.mcp ? ['salaam_mcp'] : []),
              ...(c.toolkit ? ['salaam_toolkit'] : []),
              ...(c.station ? ['salaam_station'] : []),
              ...(c.operator_mcp?.length ? ['salaam_operator_mcp'] : []),
              ...(c.local ? ['salaam_workspace'] : []),
              ...(c.localCoding ? ['salaam_local', 'salaam_tasks'] : []),
            ],
      ),
      ...(c.mcp ? { mcp: c.mcp } : {}),
      ...(c.operator_mcp ? { operator_mcp: c.operator_mcp } : {}),
      ...(c.mcp_servers
        ? { mcp_servers: c.mcp_servers, mcp_servers_digest: digest(c.mcp_servers) }
        : {}),
      ...(c.toolkit ? { toolkit: c.toolkit } : {}),
      ...(c.station ? { station: c.station } : {}),
      ...(c.persona ? { persona_digest: c.persona.digest } : {}),
      ...(c.coding ? { coding: c.coding } : {}),
      tools: pi
        .getAllTools()
        .filter((tool) => tool.exposure !== 'hidden')
        .map((tool) => tool.name)
        .sort(),
      active_tools: pi.getActiveTools().sort(),
      provider: route.provider,
      route,
      context_digest: textDigest(c.frame),
      ...(c.worker_binding ? { worker_binding: c.worker_binding } : {}),
    });
    timer = setInterval(() => {
      void bridge('heartbeat').catch(() => {
        clearInterval(timer);
        shutdown?.();
      });
    }, HEARTBEAT_INTERVAL);
    timer.unref();
  });
  pi.on('session_shutdown', () => {
    clearInterval(timer);
  });
}
