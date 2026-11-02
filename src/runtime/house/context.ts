// What every part of the house extension shares: the worker configuration Salaam hands Pi, the
// bridge back to the service, and the required-control failure path. These files run inside the
// Pi process and import files directly, never a module's index (see architecture.test.ts).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { call } from '../../core/transport.js';
import type { ProviderRoute } from '../../core/provider-route.js';
import type { CodingBinding } from '../../core/protocol.js';
import type { WorkerBoundaryView } from '../../core/worker-binding.js';
import type { McpServerProvenance } from '../../core/records.js';
import type { McpWorkerBinding } from '../../mcp/work.js';
import type { ToolkitWorkerBinding } from '../../toolkit/work.js';
import type { StationBinding } from '../station.js';
import type { Persona } from '../persona.js';

export interface WorkerConfig {
  socket: string;
  token: string;
  session: string;
  epoch: number;
  bundle: string;
  policy: string;
  frame: string;
  effects?: boolean;
  child?: boolean;
  route?: ProviderRoute;
  coding?: CodingBinding;
  local?: boolean;
  localCoding?: boolean;
  worker_binding?: WorkerBoundaryView;
  mcp?: McpWorkerBinding;
  operator_mcp?: McpServerProvenance[];
  mcp_servers?: McpServerProvenance[];
  toolkit?: ToolkitWorkerBinding;
  station?: StationBinding;
  persona?: Persona;
}

export type Bridge = <T = unknown>(method: string, data?: unknown) => Promise<T>;

/** One part of the extension's view of the worker: Pi, its configuration, the bridge, and the
 * required-control failure that reports to the service and shuts Pi down. */
export interface House {
  pi: ExtensionAPI;
  c: WorkerConfig;
  bridge: Bridge;
  fail: () => Promise<void>;
}

/** Provider authentication and declared MCP calls may wait on a slow remote. */
const REMOTE_BRIDGE_TIMEOUT = 125000;
/** Long enough for PreToolUse hooks (at most 600 s each, as in Claude Code) plus the call itself. */
const HOOKED_BRIDGE_TIMEOUT = 11 * 60 * 1000;
const STATION_BRIDGE_TIMEOUT = 35000;
const BRIDGE_TIMEOUT = 2000;

export function workerBridge(c: WorkerConfig): Bridge {
  return <T = unknown>(method: string, data: unknown = {}) =>
    call<T>(
      c.socket,
      `/worker/${c.session}/${method}`,
      { epoch: c.epoch, ...(data as object) },
      c.token,
      method === 'provider.auth' || method.startsWith('operator_mcp.')
        ? REMOTE_BRIDGE_TIMEOUT
        : // PreToolUse hooks run before these answer, each for up to its own timeout (Phase 4b).
          method === 'local.prepare' || method === 'local.read' || method.startsWith('web.')
          ? HOOKED_BRIDGE_TIMEOUT
          : method.startsWith('station.')
            ? STATION_BRIDGE_TIMEOUT
            : BRIDGE_TIMEOUT,
    );
}
