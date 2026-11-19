import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp, DEFAULT_PORT } from './index';

/**
 * `luna-studio-mcp`: the MCP server on stdio, for Claude Code or Claude
 * Desktop to start. Options: `--port <n>` (or GJS_MCP_PORT), `--token <t>`
 * (or GJS_MCP_TOKEN). The studio connects when started with `--mcp`.
 */
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1];
};

if (argv.includes('-h') || argv.includes('--help')) {
  process.stderr.write(`luna-studio-mcp [--port <n>] [--token <t>]

The MCP server of Luna Studio, on stdio: add it to Claude Code with
  claude mcp add luna-studio -- npx luna-studio-mcp
then start the studio with \`luna-studio <folder> --mcp\` and open it.
The editor connects to ws://127.0.0.1:<port> (default ${DEFAULT_PORT}).
`);
  process.exit(0);
}

const port = opt('--port');
const mcp = createMcp({ port: port != null ? Number(port) : undefined, token: opt('--token') });
// A taken port is logged; the MCP side still answers (editor_status says how to fix it).
await mcp.listening.catch(() => undefined);
await mcp.server.connect(new StdioServerTransport());
process.stderr.write('[luna-studio-mcp] ready on stdio\n');

const stop = () => void mcp.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
