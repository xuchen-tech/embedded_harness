import * as http from 'http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { HarnessDataService } from './harnessDataService';
import { createHarnessMcpServer } from './server';

export class McpHost {
  private httpServer: http.Server | undefined;
  private transports = new Map<string, SSEServerTransport>();

  constructor(
    private readonly data: HarnessDataService,
    private readonly port: number,
    private readonly apiKey?: string
  ) {}

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.httpServer !== undefined;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    this.httpServer = http.createServer(async (req, res) => {
      if (!this.authorize(req)) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/message', res);
        const sessionId = transport.sessionId;
        this.transports.set(sessionId, transport);
        res.on('close', () => this.transports.delete(sessionId));

        const mcp = createHarnessMcpServer(this.data);
        await mcp.connect(transport);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/message') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const transport = this.transports.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end('Session not found');
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'embedded-harness-mcp' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, '127.0.0.1', () => resolve());
      this.httpServer!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) {
      return;
    }
    for (const t of this.transports.values()) {
      await t.close();
    }
    this.transports.clear();
    await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    this.httpServer = undefined;
  }

  private authorize(req: http.IncomingMessage): boolean {
    if (!this.apiKey) {
      return true;
    }
    const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace('Bearer ', '');
    return header === this.apiKey;
  }
}

export function getMcpCursorConfig(
  extensionPath: string,
  storageDir: string,
  apiKey?: string
): object {
  return {
    'embedded-harness': {
      command: 'node',
      args: [`${extensionPath}/out/mcp/stdioMain.js`, '--storage', storageDir],
      env: apiKey ? { HARNESS_MCP_API_KEY: apiKey } : {},
    },
  };
}
