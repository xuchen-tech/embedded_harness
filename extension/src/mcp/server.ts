import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HarnessDataService } from './harnessDataService';
import {
  analyzeCpuSpike,
  analyzeLaunchFailure,
  analyzeMemoryLeak,
} from './diagnostics';

export function createHarnessMcpServer(data: HarnessDataService): Server {
  const server = new Server(
    { name: 'embedded-harness', version: '0.3.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_targets',
        description: 'List configured Embedded Harness targets',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_metrics_summary',
        description: 'Get latest CPU/memory metrics and short history for a target',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string' },
            durationMinutes: { type: 'number', description: 'History window (default 5)' },
          },
          required: ['targetId'],
        },
      },
      {
        name: 'get_recent_logs',
        description: 'Get recent merged logs (syslog/journal/dmesg/custom/MCU)',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string' },
            limit: { type: 'number' },
            level: { type: 'string', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] },
            source: { type: 'string' },
          },
          required: ['targetId'],
        },
      },
      {
        name: 'get_last_coredump',
        description: 'Get the most recent core dump event for a target',
        inputSchema: {
          type: 'object',
          properties: { targetId: { type: 'string' } },
          required: ['targetId'],
        },
      },
      {
        name: 'get_capabilities',
        description: 'Get remote environment capabilities (arch, logs, tools, core dump)',
        inputSchema: {
          type: 'object',
          properties: { targetId: { type: 'string' } },
          required: ['targetId'],
        },
      },
      {
        name: 'analyze_cpu_spike',
        description: 'Diagnose CPU spike in a time window',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string' },
            windowMinutes: { type: 'number' },
          },
          required: ['targetId'],
        },
      },
      {
        name: 'analyze_memory_leak',
        description: 'Analyze memory growth trend for leak hints',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string' },
            windowMinutes: { type: 'number' },
          },
          required: ['targetId'],
        },
      },
      {
        name: 'analyze_launch_failure',
        description: 'Analyze service launch/startup failures from journal/syslog',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string' },
            serviceName: { type: 'string' },
          },
          required: ['targetId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatchTool(data, name, a);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(e) }) }],
        isError: true,
      };
    }
  });

  return server;
}

async function dispatchTool(
  data: HarnessDataService,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const targetId = String(args.targetId ?? '');

  switch (name) {
    case 'list_targets':
      return data.listTargets().map((t) => ({ id: t.id, host: t.host, username: t.username }));

    case 'get_metrics_summary': {
      const minutes = Number(args.durationMinutes ?? 5);
      const latest = await data.getLiveMetrics(targetId);
      const history = data.getMetricsHistory(targetId, minutes);
      return { latest, history, sampleCount: history.length };
    }

    case 'get_recent_logs':
      return data.getRecentLogs(targetId, {
        limit: Number(args.limit ?? 100),
        level: args.level as string | undefined,
        source: args.source as string | undefined,
      });

    case 'get_last_coredump':
      return data.getLastCoreDump(targetId);

    case 'get_capabilities':
      return data.getCapabilities(targetId);

    case 'analyze_cpu_spike':
      return analyzeCpuSpike(data, targetId, Number(args.windowMinutes ?? 5));

    case 'analyze_memory_leak':
      return analyzeMemoryLeak(data, targetId, Number(args.windowMinutes ?? 30));

    case 'analyze_launch_failure':
      return analyzeLaunchFailure(data, targetId, args.serviceName as string | undefined);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
