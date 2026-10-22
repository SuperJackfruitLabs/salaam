// A tiny MCP server for operator-declared MCP tests: stdio by default, or one handler
// factory reused by the in-process streamable HTTP fixture.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function fixtureServer(prefix = 'fixture') {
  const server = new Server(
    { name: 'operator-fixture', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'stamp',
        description: 'Return a fixed stamp for a label',
        inputSchema: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `${prefix}-stamp:${request.params.arguments?.label}` }],
  }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const marker = process.argv.indexOf('--marker');
  if (marker > 0) appendFileSync(process.argv[marker + 1], `started ${process.pid}\n`);
  const prefix = process.argv.includes('--prefix')
    ? process.argv[process.argv.indexOf('--prefix') + 1]
    : 'fixture';
  await fixtureServer(prefix).connect(new StdioServerTransport());
}
