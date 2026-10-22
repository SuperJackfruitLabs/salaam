import {
  declarationDigest,
  operatorMcpPath,
  readOperatorMcpFile,
  validateDeclaration,
  writeOperatorMcpFile,
  type McpDeclaration,
} from './operator-mcp.js';

export const MCP_HELP = `salaam mcp: operator-declared MCP servers

  salaam mcp add <name> [--env K='\${VAR}']... -- <command> [args...]
  salaam mcp add <name> --url <https-url> [--header K='Bearer \${VAR}']...
  salaam mcp list
  salaam mcp rm <name>

Options: --config <path> (default $XDG_CONFIG_HOME/salaam/mcp.json)
Values in --env and --header must reference environment variables as \${VAR};
inline secrets are refused. Changes apply at the next salaam service start.`;

function pairs(values: string[], flag: string): Record<string, string> | undefined {
  if (!values.length) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const i = value.indexOf('=');
    if (i < 1) throw new Error(`${flag} expects K=V`);
    const key = value.slice(0, i);
    if (Object.hasOwn(out, key)) throw new Error(`${flag} ${key} given twice`);
    out[key] = value.slice(i + 1);
  }
  return out;
}

/** `salaam mcp ...`; argv excludes the leading "mcp". Returns text for stdout. */
export function mcpCli(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const dash = argv.indexOf('--');
  const head = dash < 0 ? [...argv] : argv.slice(0, dash);
  const command = dash < 0 ? [] : argv.slice(dash + 1);
  const take = (flag: string, many = false): string[] => {
    const found: string[] = [];
    for (let i = head.indexOf(flag); i >= 0; i = head.indexOf(flag)) {
      const value = head[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      found.push(value);
      head.splice(i, 2);
      if (!many) break;
    }
    return found;
  };
  const path = take('--config')[0] ?? operatorMcpPath(env);
  const url = take('--url')[0];
  const headers = pairs(take('--header', true), '--header');
  const envs = pairs(take('--env', true), '--env');
  const [verb, name, ...rest] = head;
  if (rest.length || head.some((x) => x.startsWith('--')))
    throw new Error('Unexpected arguments; run salaam mcp --help');
  const file = readOperatorMcpFile(path);
  if (verb === 'list') {
    if (dash >= 0 || name) throw new Error('salaam mcp list takes no arguments');
    return JSON.stringify(
      {
        config: path,
        servers: file.servers.map((s) => ({ ...s, declaration_digest: declarationDigest(s) })),
      },
      null,
      2,
    );
  }
  if (!name) throw new Error('A server name is required');
  if (verb === 'rm') {
    if (dash >= 0 || url || headers || envs) throw new Error('salaam mcp rm takes only a name');
    const servers = file.servers.filter((s) => s.name !== name);
    if (servers.length === file.servers.length) throw new Error(`No declared server "${name}"`);
    writeOperatorMcpFile(path, { version: 1, servers });
    return JSON.stringify({ removed: name, config: path });
  }
  if (verb === 'add') {
    if (file.servers.some((s) => s.name === name))
      throw new Error(`Server "${name}" is already declared; rm it first`);
    let declaration: McpDeclaration;
    if (url) {
      if (command.length || envs) throw new Error('Use either --url or -- <command>, not both');
      declaration = validateDeclaration({
        name,
        transport: 'http',
        url,
        ...(headers ? { headers } : {}),
      });
    } else {
      if (!command.length) throw new Error('Supply -- <command> [args...] or --url <url>');
      if (headers) throw new Error('--header applies to --url servers');
      declaration = validateDeclaration({
        name,
        transport: 'stdio',
        command: command[0],
        args: command.slice(1),
        ...(envs ? { env: envs } : {}),
      });
    }
    writeOperatorMcpFile(path, { version: 1, servers: [...file.servers, declaration] });
    return JSON.stringify({
      added: name,
      config: path,
      declaration_digest: declarationDigest(declaration),
    });
  }
  throw new Error('Use salaam mcp add, list or rm');
}
