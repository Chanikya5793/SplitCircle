/**
 * aiService.ts — App-side client for the SplitCircle AI layer.
 *
 * Talks to the `askExpenseAi` callable (functions/src/askExpenseAi.ts), which
 * proxies to the RAG service server-side — the app never holds AI-layer secrets
 * and the uid always comes from the Firebase token.
 *
 * Privacy: the question is passed through `redactPII` BEFORE it leaves the
 * device (NSDataDetector on iOS via the splitcircle-ai native module, JS regex
 * fallback elsewhere). After a successful answer we donate the "Ask SplitCircle"
 * activity so iOS surfaces it in Spotlight/Siri Suggestions.
 */

import { app } from '@/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { donateAskActivity, redactPII } from '../../modules/splitcircle-ai';

const functions = getFunctions(app);

export interface ExpenseAiSource {
  expenseId: string;
  groupId: string;
  title?: string;
  category?: string;
  amount: number;
  currency?: string;
  paidByName?: string;
  createdAt?: number;
}

export interface ExpenseAiAnswer {
  answer: string;
  sources: ExpenseAiSource[];
  confidence: number;
}

type AskExpenseAiPayload = { question: string; groupId?: string; topK?: number };

const askExpenseAiCallable = httpsCallable<AskExpenseAiPayload, ExpenseAiAnswer>(
  functions,
  'askExpenseAi',
);

export class AiUnavailableError extends Error {
  constructor(message = 'The AI assistant is not available yet.') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/**
 * Ask the AI assistant a natural-language question about the user's expenses.
 * Returns a grounded, cited answer. Throws `AiUnavailableError` when the AI
 * layer isn't enabled/deployed so callers can hide the feature gracefully.
 */
export async function askExpenseAi(
  question: string,
  options: { groupId?: string; topK?: number } = {},
): Promise<ExpenseAiAnswer> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Error('Ask a question about your expenses.');
  }

  // Scrub contact details before the text leaves the device (Critical Rule #3).
  const safeQuestion = redactPII(trimmed);

  try {
    const result = await askExpenseAiCallable({
      question: safeQuestion,
      groupId: options.groupId,
      topK: options.topK,
    });

    // Fire-and-forget Siri/Spotlight donation (no-op off iOS).
    void donateAskActivity(safeQuestion);

    return result.data;
  } catch (error) {
    const code = (error as { code?: string })?.code ?? '';
    if (code.includes('failed-precondition') || code.includes('unavailable')) {
      throw new AiUnavailableError();
    }
    throw error;
  }
}

export { redactPII };
