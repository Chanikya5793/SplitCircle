/**
 * tool.ts — Tool contract shared by every splitcircle-core tool.
 *
 * Each tool exports a `Tool` object: a zod input schema (→ JSON Schema for the
 * MCP `inputSchema`), MCP annotations, and a pure-ish `handler(args, ctx)` that
 * receives the authenticated uid + DataAccess. This shape makes tools testable
 * without the MCP SDK or Firestore.
 */

import type { z } from 'zod';
import type { DataAccess } from './dataAccess.js';
import type { ToolResult } from './types.js';

export interface ToolContext {
  /** Authenticated uid from the verified Firebase token (never from args). */
  uid: string;
  data: DataAccess;
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}
