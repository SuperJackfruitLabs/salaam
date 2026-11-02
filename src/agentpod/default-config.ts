import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The AgentPod pins a node operator drops for this user, used when
 * `service start` names no --agentpod-config. Without it a daemon an AgentPod
 * node expects to bind starts unbound and the node never detects a station.
 */
export function defaultAgentPodConfig(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  const path = join(base, 'salaam', 'agentpod-pins.json');
  return exists(path) ? path : undefined;
}
