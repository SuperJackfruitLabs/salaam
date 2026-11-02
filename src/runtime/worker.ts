// One supervised Pi worker as the supervisor tracks it: its credentials, readiness, grants and the
// attempt it is running.
import type { Manifest, McpServerProvenance } from '../core/index.js';
import type { McpWorkerBinding } from '../mcp/index.js';
import type { ToolkitWorkerBinding } from '../toolkit/index.js';
import type { StationBinding } from './station.js';
import type { BridgeWorker } from './bridge/bridge.js';
import type { PiProcess } from './pi.js';

export interface Worker extends BridgeWorker {
  mcp?: McpWorkerBinding;
  toolkit?: ToolkitWorkerBinding;
  station?: StationBinding;
  operatorMcp?: McpServerProvenance[];
  mcpServers?: McpServerProvenance[];
  id: string;
  token: string;
  frame: string;
  compaction?: string;
  bundle: string;
  ready: boolean;
  invalid: string | null;
  stopping: boolean;
  pi?: PiProcess;
  manifest?: Manifest;
  lastBeat: number;
  busy: boolean;
  attempt?: string;
  handshake: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}
