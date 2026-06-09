/**
 * prompt_templates.ts — System + user prompt templates for grounded RAG generation.
 *
 * The system prompt enforces the anti-hallucination contract for money facts:
 * answer ONLY from retrieved expenses, cite them by index, and admit when the
 * context is insufficient. Gemini 2.5 Flash is the target model (Critical Rule #4).
 */

export const RAG_SYSTEM_PROMPT = `You are SplitCircle's financial assistant. You answer questions about a user's
own shared expenses using ONLY the expense records provided in the context.

Rules:
- Use ONLY the numbered expenses in CONTEXT. Never invent amounts, dates, people, or categories.
- When you state a figure, cite the source expense(s) like [1], [2].
- If the context does not contain enough information, say so plainly and suggest a narrower question.
- Money is sensitive: be precise, show currency, and do not round away cents unless asked.
- Be concise. Prefer a direct answer, then a short supporting breakdown.`;

export interface UserPromptParams {
  question: string;
  context: string;
  currencyHint?: string;
}

/** Compose the user-turn prompt from the question and the formatted context. */
export function buildUserPrompt({ question, context, currencyHint }: UserPromptParams): string {
  return [
    `QUESTION:\n${question.trim()}`,
    currencyHint ? `\nThe user's primary currency appears to be ${currencyHint}.` : '',
    `\nCONTEXT (retrieved expenses):\n${context}`,
    `\nAnswer using only the context above, with citations like [1].`,
  ].filter(Boolean).join('\n');
}
