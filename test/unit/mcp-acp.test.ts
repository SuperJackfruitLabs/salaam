import { expect, test } from 'vitest';
import { validateManagedMcpDeclarations } from '../../src/mcp-acp.js';
import { mcpAssignment, mcpProfile } from '../../src/mcp-protocol.js';
import { digest } from '../../src/protocol.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };

const assigned = mcpAssignment(corpus.assignments[0]!.value),
  profile = mcpProfile(corpus.profiles[0]!.value);
const view = {
  version: 1 as const,
  profile_digest: assigned.profile_digest,
  assignment_digest: digest(assigned),
  binding_digest: digest(assigned.binding),
  credential_generation: assigned.credential_generation,
  servers: profile.servers.map((s) => ({
    name: s.name,
    endpoint_digest: digest(assigned.servers.find((a) => a.name === s.name)!.url),
    catalog_digest: s.catalog_digest,
    tools: s.tools,
  })),
};
const declared = assigned.servers.map((s) => ({ ...s, headers: [] }));
test('ACP admits only credential-free declarations of exactly assigned endpoints', () => {
  expect(() => validateManagedMcpDeclarations(declared, view)).not.toThrow();
  expect(() => validateManagedMcpDeclarations([], view)).not.toThrow();
  expect(() => validateManagedMcpDeclarations([])).not.toThrow();
  for (const input of [
    assigned.servers,
    undefined,
    {},
    [...declared, ...declared],
    [{ ...declared[0], url: 'http://127.0.0.1:43421/stations/other/mcp/superlibrary' }],
    [{ ...declared[0], command: '/tmp/other' }],
    [{ ...declared[0], type: 'sse' }],
    [{ ...declared[0], headers: [{ name: 'Authorization', value: 'offline' }] }],
  ])
    expect(() => validateManagedMcpDeclarations(input, view)).toThrow();
  expect(() => validateManagedMcpDeclarations(declared)).toThrow();
});
