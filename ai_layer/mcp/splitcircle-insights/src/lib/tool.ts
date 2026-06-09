/**
 * tool.ts — Tool contract for splitcircle-insights (mirrors splitcircle-core).
 */

import type { z } from 'zod';
import type { InsightsToolContext } from './analytics.js';

export interface ToolResult<T = unknown> { data: T; text: string }

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: z.infer<S>, ctx: InsightsToolContext) => Promise<ToolResult>;
}
