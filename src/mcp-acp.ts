import { canonical, digest, object, ServiceError } from './protocol.js';
import type { McpWorkerBinding } from './mcp-work.js';

/** ACP declares node-assigned endpoints; only daemon control carries their credentials. */
export function validateManagedMcpDeclarations(
  input: unknown,
  assignment?: McpWorkerBinding | null,
): void {
  const fail = () =>
    new ServiceError(
      'mcp_declaration_mismatch',
      'ACP MCP declarations must match the private node assignment and contain no headers',
      400,
    );
  if (!Array.isArray(input)) throw fail();
  if (!input.length) return;
  if (!assignment || input.length !== assignment.servers.length) throw fail();
  const seen = new Set<string>();
  for (const value of input) {
    const server = object(value);
    if (
      Object.keys(server).sort().join(',') !== 'headers,name,type,url' ||
      server.type !== 'http' ||
      typeof server.name !== 'string' ||
      typeof server.url !== 'string' ||
      canonical(server.headers) !== '[]' ||
      seen.has(server.name)
    )
      throw fail();
    const pinned = assignment.servers.find((s) => s.name === server.name);
    if (!pinned || pinned.endpoint_digest !== digest(server.url)) throw fail();
    seen.add(server.name);
  }
}
