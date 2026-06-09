/**
 * server.ts — Builds the splitcircle-insights MCP server bound to one user.
 * Mirrors the splitcircle-core pattern: per-session uid, zod validation, MCP-
 * compliant error reporting. All tools are read-only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Analytics, InsightsToolContext } from './lib/analytics.js';
import { tools } from './tools/index.js';

export interface SessionContext { uid: string; analytics: Analytics }

export function buildServer(ctx: SessionContext): McpServer {
  const server = new McpServer(
    { name: 'splitcircle-insights', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const toolCtx: InsightsToolContext = { uid: ctx.uid, analytics: ctx.analytics };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema.shape, annotations: tool.annotations } as any,
      async (rawArgs: unknown) => {
        try {
          const args = tool.inputSchema.parse(rawArgs ?? {});
          const result = await tool.handler(args, toolCtx);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            structuredContent: result.data as Record<string, unknown>,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: err instanceof Error ? err.message : 'Unexpected error.' }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
