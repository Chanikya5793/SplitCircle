/**
 * aiText.ts — output hygiene for on-device/PCC narrative text (doc 22).
 *
 * Small on-device models decorate (markdown, preambles, quotes), deflect
 * ("I don't have enough expense data"), and occasionally invent numbers.
 * Nothing a model writes is rendered verbatim: chat replies pass through
 * `stripModelDecorations`, and the stats narrative card additionally passes
 * `sanitizeNarrative`, which REJECTS (returns null) instead of shipping a
 * deflection, scaffold echo, or ungrounded number — callers fall through to
 * the next engine tier and ultimately to the deterministic heuristic cards.
 *
 * Pure string functions (no RN imports) so they run under vitest as-is.
 * NOTE: no regex lookbehind — Hermes compatibility.
 */

/** Sentences kept in the stats narrative card (instructions ask for 2-3). */
const MAX_NARRATIVE_SENTENCES = 4;
/** Anything shorter is a fragment, not an insight. */
const MIN_NARRATIVE_LENGTH = 25;

/**
 * Strip the formatting wrappers models add despite "plain text only": code
 * fences, wrapping quotes, markdown emphasis/headers/bullets, and stray
 * newlines. Content-preserving — never rejects.
 */
export function stripModelDecorations(raw: string): string {
  let s = (raw ?? '').trim();
  // Code fences (``` or ```lang ... ```), keeping the inner text.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  // One matching pair of wrapping quotes.
  const quotePairs: [string, string][] = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (const [open, close] of quotePairs) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > 2) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  // Bullet/number/header prefixes at line starts.
  s = s.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,4})\s+/gm, '');
  // Emphasis markers (** __ * _ around words) and inline backticks.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=[\s.,!?:;)]|$)/g, '$1$2');
  s = s.replace(/`([^`]*)`/g, '$1');
  // Collapse all whitespace runs (incl. newlines) into single spaces.
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Chat-shaped hygiene for the agentic narrator (doc 24 adaptive verbosity):
 * strips the same decorations but PRESERVES paragraph breaks and "- " dash
 * lines, which the narrator is allowed to use. Bullets normalize to "- ";
 * markdown headers/emphasis/fences/quotes still die. Content-preserving.
 */
export function stripChatDecorations(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  const quotePairs: [string, string][] = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (const [open, close] of quotePairs) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > 2) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  // Headers die; bullets normalize to "- "; numbered lists become dash lines.
  s = s.replace(/^\s*#{1,4}\s+/gm, '');
  s = s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '- ');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=[\s.,!?:;)]|$)/g, '$1$2');
  s = s.replace(/`([^`]*)`/g, '$1');
  // Collapse horizontal whitespace only; cap blank runs at one empty line.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Leading filler before the actual content ("Sure!", "Here's the insight:"). */
const PREAMBLE_PATTERNS: RegExp[] = [
  /^(?:sure|of course|certainly|absolutely|okay|ok)[,!.:]\s+/i,
  /^here(?:'s| is| are)\b[^:]{0,60}:\s*/i,
  /^based on (?:the|these|your) (?:facts|data|numbers)(?: provided)?[,:]\s*/i,
  /^(?:insights?|summary|narrative|analysis)\s*:\s*/i,
];

function stripPreamble(text: string): string {
  let s = text;
  for (const pattern of PREAMBLE_PATTERNS) s = s.replace(pattern, '');
  return s.trim();
}

/**
 * Deflections, scaffold echoes, and meta-talk that must never render on the
 * stats card. These were the dominant failure mode of routing the narrator
 * through the Q&A-shaped askOnDevice door.
 */
const REJECT_PATTERNS: RegExp[] = [
  /\bnot enough (?:expense )?(?:data|information)\b/i,
  /\b(?:don'?t|do not|doesn'?t|does not|didn'?t) (?:have|contain|include|provide)\b[^.!?]*\b(?:data|facts|information|expenses?|lines?)\b/i,
  /\bnumbered expense lines?\b/i,
  /\bsource ?indexes?\b/i,
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\b(?:cannot|can'?t|unable to) (?:answer|help|provide|determine)\b/i,
  /\bJSON\b/i,
  /\bFACTS\b/,
];

/**
 * Cut after the `max`-th sentence boundary. A boundary is terminal punctuation
 * followed by whitespace or end-of-text — decimal points ("$1,234.56") are
 * followed by digits and never match. No lookbehind (Hermes compatibility).
 */
function clampSentences(text: string, max: number): string {
  const boundary = /[.!?]+["')”’]?(?=\s|$)/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    count += 1;
    if (count === max) {
      const end = match.index + match[0].length;
      return end < text.length ? text.slice(0, end).trim() : text;
    }
  }
  return text;
}

/**
 * True when every substantial number in `text` traces back to a number in the
 * `facts` blob. The model may round ("about 1,200" for 1234.56) but never
 * invent — tolerance is ±0.5 absolute or 5% relative. Values under 10 are
 * ignored (sentence counts, "2-3 members" phrasing), as are 4-digit years.
 */
export function numbersGrounded(text: string, facts: string): boolean {
  const factNumbers = (facts.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const deThousands = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const candidates = (deThousands.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((n) => n >= 10 && !(Number.isInteger(n) && n >= 1900 && n <= 2100));
  return candidates.every((n) =>
    factNumbers.some((f) => Math.abs(n - f) <= 0.5 || (f > 0 && Math.abs(n - f) / f <= 0.05)),
  );
}

/**
 * Full hygiene pass for the stats narrative card: strip decorations and
 * preamble, reject deflections / scaffold echoes / ungrounded numbers, clamp
 * to a card-sized sentence count. Returns null when the text should NOT be
 * shown — the caller falls through to the next tier (heuristic cards always
 * render, so rejecting is always safe).
 */
export function sanitizeNarrative(raw: string, facts: string): string | null {
  let s = stripPreamble(stripModelDecorations(raw));
  if (s.length < MIN_NARRATIVE_LENGTH) return null;
  if (/[{}[\]]/.test(s)) return null; // JSON / scaffold residue
  for (const pattern of REJECT_PATTERNS) {
    if (pattern.test(s)) return null;
  }
  s = clampSentences(s, MAX_NARRATIVE_SENTENCES);
  if (!numbersGrounded(s, facts)) return null;
  return s;
}
