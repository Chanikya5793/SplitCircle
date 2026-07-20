/**
 * aiMemoryService.ts — AsyncStorage store for the AI memory (doc 25 Q2).
 *
 * Scopes: 'global' (explicit "remember …" facts/preferences), 'group:<id>'
 * (learned entity fixes + patterns per group), 'personal'. Injection and the
 * entity-fix map merge global + the turn's scope. Toggles are GLOBAL (one set,
 * stored on the global doc) — the ledger's per-category switches.
 *
 * Local tier only (NEVER Firestore). Every read/write is guarded — memory is
 * seasoning; a storage failure must never break a turn.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  bumpCounter,
  buildMemoryBlock,
  DEFAULT_TOGGLES,
  entityFixMap,
  entityFixText,
  MEMORY_ITEM_CAP,
  norm,
  patternHintLine,
  patternRows,
  PICKS_CAP,
  shouldPromoteFix,
  type ClarifyPick,
  type MemoryItem,
  type MemoryKind,
  type MemoryToggles,
  type PatternCounters,
} from '@/utils/aiMemory';

const KEY = (scope: string): string => `ai_memory_v1:${scope}`;
const SCOPES_KEY = 'ai_memory_scopes_v1';

interface MemoryDoc {
  items: MemoryItem[];
  picks: ClarifyPick[];
  counters: PatternCounters;
  /** Only meaningful on the 'global' doc. */
  toggles?: MemoryToggles;
}

const EMPTY: MemoryDoc = { items: [], picks: [], counters: {} };

const cache = new Map<string, MemoryDoc>();

let idSeq = 0;
const newId = (): string => `mem-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;

async function load(scope: string): Promise<MemoryDoc> {
  const hit = cache.get(scope);
  if (hit) return hit;
  try {
    const raw = await AsyncStorage.getItem(KEY(scope));
    const doc = raw ? ({ ...EMPTY, ...(JSON.parse(raw) as MemoryDoc) }) : { ...EMPTY };
    cache.set(scope, doc);
    return doc;
  } catch {
    const doc = { ...EMPTY };
    cache.set(scope, doc);
    return doc;
  }
}

async function save(scope: string, doc: MemoryDoc): Promise<void> {
  cache.set(scope, doc);
  try {
    await AsyncStorage.setItem(KEY(scope), JSON.stringify(doc));
    // Track known scopes so wipeAll and the ledger can enumerate them.
    const raw = await AsyncStorage.getItem(SCOPES_KEY);
    const scopes = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    if (!scopes.has(scope)) {
      scopes.add(scope);
      await AsyncStorage.setItem(SCOPES_KEY, JSON.stringify([...scopes]));
    }
  } catch {
    // Best-effort — cache still serves this session.
  }
}

export async function getToggles(): Promise<MemoryToggles> {
  const doc = await load('global');
  return { ...DEFAULT_TOGGLES, ...doc.toggles };
}

export async function setToggle(kind: MemoryKind, enabled: boolean): Promise<void> {
  const doc = await load('global');
  await save('global', { ...doc, toggles: { ...DEFAULT_TOGGLES, ...doc.toggles, [kind]: enabled } });
}

/** Add an explicit fact/preference (the "remember …" intent). Returns the item. */
export async function addItem(
  scope: string,
  kind: 'fact' | 'preference',
  text: string,
): Promise<MemoryItem> {
  const doc = await load(scope);
  const now = Date.now();
  const item: MemoryItem = { id: newId(), kind, text, provenance: 'you told me', createdAt: now, updatedAt: now };
  const items = [...doc.items, item].slice(-MEMORY_ITEM_CAP);
  await save(scope, { ...doc, items });
  return item;
}

/**
 * Idempotent derived-fact upsert keyed by a stable text prefix (doc 26 —
 * e.g. the "Recurring commitments: …" line). Replaces the previous fact with
 * the same prefix instead of appending duplicates; no-ops when unchanged.
 */
export async function upsertFactByPrefix(scope: string, prefix: string, text: string): Promise<void> {
  const doc = await load(scope);
  const now = Date.now();
  const existing = doc.items.find((i) => i.kind === 'fact' && i.text.startsWith(prefix));
  if (existing?.text === text) return;
  const items = existing
    ? doc.items.map((i) => (i.id === existing.id ? { ...i, text, updatedAt: now } : i))
    : [
        ...doc.items,
        { id: newId(), kind: 'fact' as const, text, provenance: 'derived from recurring bills', createdAt: now, updatedAt: now },
      ].slice(-MEMORY_ITEM_CAP);
  await save(scope, { ...doc, items });
}

export async function deleteItem(scope: string, id: string): Promise<void> {
  const doc = await load(scope);
  await save(scope, { ...doc, items: doc.items.filter((i) => i.id !== id) });
}

export async function deletePattern(scope: string, key: string): Promise<void> {
  const doc = await load(scope);
  const counters = { ...doc.counters };
  delete counters[key];
  await save(scope, { ...doc, counters });
}

export async function wipeScope(scope: string): Promise<void> {
  await save(scope, { ...EMPTY, toggles: (await load(scope)).toggles });
}

export async function listScopes(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SCOPES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function wipeAll(): Promise<void> {
  for (const scope of await listScopes()) await wipeScope(scope);
}

/** Everything the ledger renders for one scope. */
export async function listLedger(scope: string): Promise<{
  items: MemoryItem[];
  patterns: { key: string; text: string; provenance: string }[];
}> {
  const doc = await load(scope);
  return { items: doc.items, patterns: patternRows(doc.counters) };
}

// ── Learning (called by the pipeline; all guarded fire-and-forget) ───────────

/**
 * Record a clarify resolution. After two consistent picks for the same alias
 * the fix is promoted: "sam" stops asking. Consistent-with-different-choice
 * resets nothing — the last two just have to agree.
 */
export async function recordClarifyPick(scope: string, alias: string, choice: string): Promise<void> {
  try {
    const doc = await load(scope);
    const picks = [...doc.picks, { alias: norm(alias), choice, at: Date.now() }].slice(-PICKS_CAP);
    let items = doc.items;
    const promoted = shouldPromoteFix(picks, alias);
    if (promoted) {
      const key = norm(alias);
      const now = Date.now();
      const existing = items.find((i) => i.kind === 'entityFix' && i.key === key);
      const fix: MemoryItem = {
        id: existing?.id ?? newId(),
        kind: 'entityFix',
        key,
        value: promoted,
        text: entityFixText(alias, promoted),
        provenance: 'picked twice in clarifications',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      items = [...items.filter((i) => i.id !== fix.id), fix].slice(-MEMORY_ITEM_CAP);
    }
    await save(scope, { ...doc, picks, items });
  } catch {
    // Learning is best-effort.
  }
}

/** Bump usage counters for the observed-patterns tier (toggle-respecting). */
export async function recordTurnPattern(
  scope: string,
  hints: { category?: string; period?: string },
): Promise<void> {
  try {
    if (!(await getToggles()).pattern) return;
    const doc = await load(scope);
    let counters = doc.counters;
    if (hints.category) counters = bumpCounter(counters, `topic:${hints.category}`);
    if (hints.period) counters = bumpCounter(counters, `period:${hints.period}`);
    if (counters !== doc.counters) await save(scope, { ...doc, counters });
  } catch {
    // Best-effort.
  }
}

// ── Injection (called by the pipeline per turn) ──────────────────────────────

/** The MEMORY prompt block for a turn: global + scope, toggle- and cap-aware. */
export async function getInjection(scopes: string[]): Promise<string> {
  try {
    const toggles = await getToggles();
    const docs = await Promise.all(scopes.map(load));
    const items = docs.flatMap((d) => d.items);
    const counters = docs.reduce<PatternCounters>((acc, d) => {
      for (const [k, v] of Object.entries(d.counters)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {});
    return buildMemoryBlock(items, toggles, patternHintLine(counters));
  } catch {
    return '';
  }
}

/** Merged alias → display-name map for deterministic member-arg rewriting. */
export async function getEntityFixes(scopes: string[]): Promise<Record<string, string>> {
  try {
    const toggles = await getToggles();
    const docs = await Promise.all(scopes.map(load));
    return entityFixMap(docs.flatMap((d) => d.items), toggles);
  } catch {
    return {};
  }
}

/** Test/diagnostics hook. */
export function __clearMemoryCache(): void {
  cache.clear();
}
