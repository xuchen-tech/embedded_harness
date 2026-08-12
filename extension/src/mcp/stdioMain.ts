#!/usr/bin/env node
/**
 * Standalone stdio MCP entry for Cursor / Claude Desktop.
 * Usage: node out/mcp/stdioMain.js --storage <history-dir>
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HarnessDataService } from './harnessDataService';
import { createHarnessMcpServer } from './server';

function parseArgs(): { storageDir: string } {
  const args = process.argv.slice(2);
  let storageDir = process.env.HARNESS_STORAGE_DIR ?? '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--storage' && args[i + 1]) {
      storageDir = args[i + 1];
      i++;
    }
  }
  if (!storageDir) {
    console.error('Usage: stdioMain.js --storage <history-directory>');
    process.exit(1);
  }
  return { storageDir };
}

async function main(): Promise<void> {
  const { storageDir } = parseArgs();
  const data = HarnessDataService.fromStorageDir(storageDir);
  const server = createHarnessMcpServer(data);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
