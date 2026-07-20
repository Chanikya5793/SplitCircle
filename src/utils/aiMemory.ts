/**
 * aiMemory.ts — pure logic for the on-device AI memory (doc 25 Q2).
 *
 * Four kinds, all user-locked decisions:
 *  - entityFix:  learned silently after 2 consistent clarify picks ("sam" → Sam Lee)
 *  - fact:       stated facts/nicknames ("Maya is my sister") via "remember …"
 *  - preference: standing behavior asks ("keep answers short") via "remember …"
 *  - pattern:    computed usage counters, never model-written, provenance shown
 *
 * Everything is Local-tier AsyncStorage (service layer) and fully visible in
 * the ledger. Memory items MAY ride PCC prompts (explicit user decision —
 * doc 25); the doc-24 chat/call tool pin is unaffected.
 *
 * Pure module: no RN imports, vitest-covered. The service injects persistence.
 */

import { estimateTokens } from './aiThreads';

export type MemoryKind = 'entityFix' | 'fact' | 'preference' | 'pattern';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  /** The ledger line AND the prompt line — always human-readable. */
  text: string;
  /** entityFix: normalized alias this item resolves. */
  key?: string;
  /** entityFix: the display name the alias resolves to. */
  value?: string;
  /** Why this exists ("picked twice in clarifications", "you told me"). */
  provenance?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryToggles {
  entityFix: boolean;
  fact: boolean;
  preference: boolean;
  pattern: boolean;
}

export const DEFAULT_TOGGLES: MemoryToggles = {
  entityFix: true,
  fact: true,
  preference: true,
  pattern: true,
};

/** Items per scope — small on purpose; memory is seasoning, not a database. */
export const MEMORY_ITEM_CAP = 50;
/** Prompt budget for the whole MEMORY block. */
export const MEMORY_TOKEN_CAP = 300;
/** Pending clarify picks kept per scope for promotion. */
export const PICKS_CAP = 20;
/** Distinct pattern counter keys kept per scope. */
export const PATTERN_KEY_CAP = 30;
/** A pattern needs this many hits before it surfaces anywhere. */
export const PATTERN_MIN_COUNT = 3;

export const norm = (s: string): string => (s ?? '').trim().toLowerCase();

// ── Injection ────────────────────────────────────────────────────────────────

/**
 * Build the MEMORY block injected into router + narrator instructions.
 * Preference lines first (they steer behavior), then entity fixes, then facts;
 * pattern hints ride as one trailing line. Respects toggles; trims oldest-first
 * to the token cap; returns '' when nothing survives.
 */
export function buildMemoryBlock(
  items: readonly MemoryItem[],
  toggles: MemoryToggles,
  patternLine?: string | null,
): string {
  const order: MemoryKind[] = ['preference', 'entityFix', 'fact'];
  const lines: string[] = [];
  for (const kind of order) {
    if (!toggles[kind]) continue;
    for (const item of items.filter((i) => i.kind === kind)) {
      lines.push(`- ${item.text}`);
    }
  }
  if (toggles.pattern && patternLine) lines.push(`- ${patternLine}`);
  if (lines.length === 0) return '';

  const header = 'MEMORY (user-approved context — follow preferences, use name fixes):';
  let block = header;
  for (const line of lines) {
    const next = `${block}\n${line}`;
    if (estimateTokens(next) > MEMORY_TOKEN_CAP) break;
    block = next;
  }
  return block === header ? '' : block;
}

/** alias → display name map for deterministic member-arg rewriting (aiTools). */
export function entityFixMap(items: readonly MemoryItem[], toggles: MemoryToggles): Record<string, string> {
  if (!toggles.entityFix) return {};
  const map: Record<string, string> = {};
  for (const i of items) {
    if (i.kind === 'entityFix' && i.key && i.value) map[i.key] = i.value;
  }
  return map;
}

// ── Entity-fix learning (2 consistent clarify picks → fix) ───────────────────

export interface ClarifyPick {
  alias: string;
  choice: string;
  at: number;
}

/**
 * Extract the ambiguous alias from the message that CAUSED a clarify: the
 * token that prefix-matches ≥2 of the offered options ("what does sam owe" +
 * ["Sam Lee","Samir"] → "sam"). Null when nothing matches — no learning then.
 */
export function extractClarifyAlias(priorUserText: string, options: readonly string[]): string | null {
  const tokens = norm(priorUserText)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  for (const token of tokens) {
    const hits = options.filter((o) => {
      const first = norm(o).split(/\s+/)[0];
      return first.startsWith(token) || token.startsWith(first);
    });
    if (hits.length >= 2) return token;
  }
  return null;
}

/**
 * Given the pick history INCLUDING the new pick (appended by the caller),
 * decide whether the alias should be promoted to an entityFix: the last two
 * picks for this alias exist and agree.
 */
export function shouldPromoteFix(picks: readonly ClarifyPick[], alias: string): string | null {
  const forAlias = picks.filter((p) => p.alias === norm(alias));
  if (forAlias.length < 2) return null;
  const [a, b] = forAlias.slice(-2);
  return a.choice === b.choice ? a.choice : null;
}

/** The ledger/prompt line for a learned fix. */
export function entityFixText(alias: string, choice: string): string {
  return `"${alias}" means ${choice}`;
}

// ── Patterns (computed counters, never model-written) ────────────────────────

export type PatternCounters = Record<string, number>;

/** Bump a counter, evicting the smallest key when over the cap. */
export function bumpCounter(counters: PatternCounters, key: string): PatternCounters {
  const next = { ...counters, [key]: (counters[key] ?? 0) + 1 };
  const keys = Object.keys(next);
  if (keys.length > PATTERN_KEY_CAP) {
    const smallest = keys.sort((a, b) => next[a] - next[b])[0];
    delete next[smallest];
  }
  return next;
}

/** Human label for a counter key ("topic:Food" → "Food"). */
const patternLabel = (key: string): string => key.slice(key.indexOf(':') + 1);

/** One compact hint line ("often asks about: Food (6×), last month (4×)"). */
export function patternHintLine(counters: PatternCounters, max = 3): string | null {
  const top = Object.entries(counters)
    .filter(([, n]) => n >= PATTERN_MIN_COUNT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  if (top.length === 0) return null;
  return `often asks about: ${top.map(([k, n]) => `${patternLabel(k)} (${n}×)`).join(', ')}`;
}

/** Ledger rows for the patterns section (provenance = the count). */
export function patternRows(counters: PatternCounters): { key: string; text: string; provenance: string }[] {
  return Object.entries(counters)
    .filter(([, n]) => n >= PATTERN_MIN_COUNT)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, text: patternLabel(key), provenance: `asked ${n}×` }));
}

// ── "remember …" parsing (explicit memory writes) ────────────────────────────

const REMEMBER_RE = /^(?:please\s+)?(?:remember|don'?t\s+forget)\b/i;
const REMEMBER_STRIP_RE = /^(?:please\s+)?(?:remember|don'?t\s+forget)\s*(?:that\s+|:\s*)?/i;
const PREFERENCE_LEAD_RE = /^(?:always|never|keep|don'?t|stop|use|prefer|show|answer)\b/i;

export interface RememberCommand {
  kind: 'fact' | 'preference';
  text: string;
}

/**
 * Parse an explicit "remember that …" / "don't forget …". Returns null for
 * non-remember text AND for remember-phrases carrying an amount ("remember I
 * paid Sam 20") — those belong to the money flows, not memory.
 */
export function parseRememberCommand(message: string, hasAmount: boolean): RememberCommand | null {
  const q = (message ?? '').trim();
  if (!REMEMBER_RE.test(q)) return null;
  if (hasAmount) return null;
  const text = q.replace(REMEMBER_STRIP_RE, '').trim().replace(/[.!]\s*$/, '');
  if (text.length < 3) return null;
  return { kind: PREFERENCE_LEAD_RE.test(text) ? 'preference' : 'fact', text };
}
