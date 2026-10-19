import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { canonical, digest, ServiceError } from './protocol.js';
import { mcpProfile, mcpAssignment, mcpAdmissionView, type McpProfile } from './mcp-protocol.js';
import type { AgentPodBinding, AgentPodPins } from './agentpod-protocol.js';

export function readMcpProfile(path: string, pins: AgentPodPins): McpProfile {
  try {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      realpathSync(path) !== path ||
      path === pins.workspace ||
      path.startsWith(pins.workspace.replace(/\/$/, '') + sep)
    )
      throw Error('Unsafe profile path');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let profile: McpProfile;
    try {
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.uid !== process.getuid?.() ||
        st.mode & 0o077 ||
        st.nlink !== 1 ||
        st.size > 262144
      )
        throw Error('Unsafe profile file');
      profile = mcpProfile(JSON.parse(readFileSync(fd, 'utf8')));
      const after = fstatSync(fd);
      if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || after.nlink !== 1)
        throw Error('Profile changed during read');
    } finally {
      closeSync(fd);
    }
    return profile;
  } catch {
    throw new ServiceError(
      'mcp_profile_changed',
      'Reviewed private MCP profile is unavailable or changed',
    );
  }
}

/** Profile integrity and data binding only. The caller must enforce the live authority lease. */
export class McpAdmission {
  readonly pins: AgentPodPins;
  constructor(
    readonly path: string,
    pins: AgentPodPins,
    readonly profileDigest: string,
  ) {
    this.pins = Object.freeze({ ...pins });
    this.profile();
  }
  profile(): McpProfile {
    try {
      const profile = readMcpProfile(this.path, this.pins);
      if (digest({ profile, pins_digest: digest(this.pins) }) !== this.profileDigest)
        throw Error('Profile digest changed');
      return profile;
    } catch {
      throw new ServiceError(
        'mcp_profile_changed',
        'Reviewed private MCP profile is unavailable or changed',
      );
    }
  }
  accept(input: unknown, current: AgentPodBinding) {
    const profile = this.profile(),
      assignment = mcpAssignment(input);
    if (
      canonical(assignment.binding) !== canonical(current) ||
      assignment.profile_digest !== this.profileDigest ||
      (Object.keys(this.pins) as (keyof AgentPodPins)[]).some(
        (key) => this.pins[key] !== current[key],
      ) ||
      canonical(assignment.servers.map((s) => s.name).sort()) !==
        canonical(profile.servers.map((s) => s.name).sort()) ||
      assignment.servers.some((s) => new URL(s.url).origin !== profile.proxy_origin)
    )
      throw new ServiceError(
        'mcp_assignment_mismatch',
        'MCP assignment differs from the reviewed profile or current authority',
      );
    return mcpAdmissionView({
      version: 1 as const,
      profile_digest: this.profileDigest,
      assignment_digest: digest(assignment),
      binding_digest: digest(current),
      credential_generation: assignment.credential_generation,
      servers: profile.servers.map((server) => ({
        name: server.name,
        endpoint_digest: digest(assignment.servers.find((s) => s.name === server.name)!.url),
        catalog_digest: server.catalog_digest,
        tools: server.tools,
      })),
    });
  }
}
