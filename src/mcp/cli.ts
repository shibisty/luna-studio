/**
 * `luna-studio-mcp`: the same as `lunastudio mcp`, kept for configurations
 * that name it. Options: `--port <n>` (or GJS_MCP_PORT), `--token <t>`
 * (or GJS_MCP_TOKEN).
 */
import { main } from '../server/commands';

main(['mcp', ...process.argv.slice(2)]).catch((e) => {
  process.stderr.write(`luna-studio-mcp: ${(e as Error).message}\n`);
  process.exit(1);
});
