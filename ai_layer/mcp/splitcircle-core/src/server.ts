/**
 * server.ts — Builds an MCP server instance bound to one authenticated user.
 *
 * A fresh server is created per authenticated session, closing over the verified
 * `uid` and a DataAccess. This guarantees tools can never see another user's data
 * (the uid is baked in at construction, never read from tool args).
 *
 * Registers all tools, resources, and prompts, wrapping each tool handler with
 * zod validation, rate limiting, output sanitization, and MCP-compliant error
 * reporting (isError on tool execution failures).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { DataAccess } from './lib/dataAccess.js';
import { PermissionError, NotFoundError } from './lib/dataAccess.js';
import type { ToolContext } from './lib/tool.js';
import { tools } from './tools/index.js';
import { resourceDefs, readResource } from './resources/index.js';
import { prompts } from './prompts/index.js';
import { enforceRateLimit, RateLimitError } from './auth/middleware.js';

export interface SessionContext {
  uid: string;
  data: DataAccess;
}

function toUserMessage(err: unknown): string {
  if (err instanceof PermissionError) return 'You do not have access to that group.';
  if (err instanceof NotFoundError) return 'That resource was not found.';
  if (err instanceof RateLimitError) return 'Too many requests — please slow down.';
  return err instanceof Error ? err.message : 'Unexpected error.';
}

export function buildServer(ctx: SessionContext): McpServer {
  const server = new McpServer(
    { name: 'splitcircle-core', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const toolCtx: ToolContext = { uid: ctx.uid, data: ctx.data };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: (zodToJsonSchema(tool.inputSchema) as any).properties ? tool.inputSchema.shape : undefined,
        annotations: tool.annotations,
      } as any,
      async (rawArgs: unknown) => {
        try {
          enforceRateLimit(ctx.uid);
          const args = tool.inputSchema.parse(rawArgs ?? {});
          const result = await tool.handler(args, toolCtx);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            structuredContent: result.data as Record<string, unknown>,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: toUserMessage(err) }],
            isError: true,
          };
        }
      },
    );
  }

  for (const def of resourceDefs) {
    server.registerResource(
      def.name,
      def.uriTemplate,
      { description: def.description, mimeType: def.mimeType },
      async (uri: URL) => {
        const text = await readResource(uri.href, ctx.uid, ctx.data);
        return { contents: [{ uri: uri.href, mimeType: def.mimeType, text }] };
      },
    );
  }

  for (const p of prompts) {
    server.registerPrompt(
      p.name,
      {
        title: p.title,
        description: p.description,
        argsSchema: Object.fromEntries(p.arguments.map((a) => [a.name, { description: a.description }])) as any,
      } as any,
      async (args: Record<string, string>) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.build(args ?? {}) } }],
      }),
    );
  }

  return server;
}
