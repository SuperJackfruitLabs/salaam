import { object, string, integer, ServiceError, canonical } from './protocol.js';

export const AGENTPOD_LEASE_MS = 90_000;
export interface AgentPodBinding {
  version: 1;
  organization_id: string;
  principal_id: string;
  node_id: string;
  station_id: string;
  station_key: string;
  occupancy_epoch: number;
  hub_session_id: string;
  workspace: string;
  run: { source: 'agentpod' | 'superpipeline'; id: string; epoch: number };
}
export type AgentPodPins = Pick<
  AgentPodBinding,
  'version' | 'organization_id' | 'node_id' | 'station_key' | 'workspace'
>;
export function agentpodBinding(input: unknown): AgentPodBinding {
  const b = object(input),
    run = object(b.run);
  const id = (v: unknown, name: string) => {
    const s = string(v, name, 128);
    if (!/^[A-Za-z0-9_.:-]+$/.test(s))
      throw new ServiceError('invalid_authority', 'Invalid authority identity');
    return s;
  };
  const result: AgentPodBinding = {
    version: 1,
    organization_id: id(b.organization_id, 'organization_id'),
    principal_id: id(b.principal_id, 'principal_id'),
    node_id: id(b.node_id, 'node_id'),
    station_id: id(b.station_id, 'station_id'),
    station_key: id(b.station_key, 'station_key'),
    occupancy_epoch: integer(b.occupancy_epoch, 'occupancy_epoch'),
    hub_session_id: id(b.hub_session_id, 'hub_session_id'),
    workspace: string(b.workspace, 'workspace', 4096),
    run: {
      source: run.source as AgentPodBinding['run']['source'],
      id: id(run.id, 'run.id'),
      epoch: integer(run.epoch, 'run.epoch'),
    },
  };
  if (
    b.version !== 1 ||
    !/^org_[a-f0-9]{20}$/.test(result.organization_id) ||
    !/^prn_[a-f0-9]{20}$/.test(result.principal_id) ||
    !/^salaam:[a-f0-9]{16}$/.test(result.station_key) ||
    !result.workspace.startsWith('/') ||
    result.workspace.includes('\0') ||
    result.occupancy_epoch < 1 ||
    result.run.epoch < 1 ||
    !['agentpod', 'superpipeline'].includes(result.run.source) ||
    canonical(result) !== canonical(b)
  )
    throw new ServiceError(
      'invalid_authority',
      'Unsupported or invalid AgentPod authority binding',
    );
  return result;
}
