import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp, type McpOptions } from './index';

/**
 * Runs the MCP server on stdio until the client goes away (`lunastudio mcp`,
 * `luna-studio-mcp`). Nothing but the protocol goes to stdout.
 */
export async function serveMcp(opts: McpOptions = {}): Promise<void> {
  const mcp = createMcp(opts);
  // A taken port is logged; the MCP side still answers (editor_status says how to fix it).
  await mcp.listening.catch(() => undefined);
  await mcp.server.connect(new StdioServerTransport());
  process.stderr.write('[luna-studio-mcp] ready on stdio\n');
  const stop = () => void mcp.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
}
