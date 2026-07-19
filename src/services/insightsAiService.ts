/**
 * insightsAiService.ts — the AI narrative tier of the stats/insights engine
 * (ai_layer/docs/22). Staging, per the locked decision:
 *
 *   1. on-device Apple Intelligence  — small/recent facts, instant + free
 *   2. Private Cloud Compute (PCC)   — whole-history analysis; larger context,
 *      Apple-private (stateless, attested). ON BY DEFAULT, disclosed, with a
 *      settings kill-switch (`pcc_deep_analysis_v1`).
 *   3. null → callers fall back to the DETERMINISTIC heuristic cards from
 *      statsInsights.ts, which always render.
 *
 * The model NARRATES precomputed facts — it never does arithmetic (doc 17's
 * #1 wrong-answer cause). Facts come from buildStatsFacts / personal stats.
 * Results are cached per facts-hash so re-opening stats doesn't re-run models.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { sanitizeNarrative } from '@/utils/aiText';
import {
  generateOnDeviceText,
  getOnDeviceAiAvailability,
  pccAsk,
  pccProbe,
} from '../../modules/splitcircle-ai';

const PCC_PREF_KEY = 'pcc_deep_analysis_v1';

export interface InsightNarrative {
  source: 'ondevice' | 'pcc';
  text: string;
}

/** PCC deep analysis is ON by default (disclosed in Settings). */
export async function getPccEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(PCC_PREF_KEY);
    return raw == null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export async function setPccEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(PCC_PREF_KEY, String(enabled));
  } catch {
    // Preference write is best-effort.
  }
}

/**
 * PCC requires Apple Intelligence eligibility — the same gate as the on-device
 * model — and a REAL device: constructing PrivateCloudComputeLanguageModel on
 * the simulator SIGSEGVs natively (observed: expo module-holder race) instead
 * of reporting unavailable, so the simulator is hard-excluded here.
 */
const pccEligible = (): boolean => {
  try {
    return Device.isDevice === true && getOnDeviceAiAvailability() === 'available';
  } catch {
    return false;
  }
};

// PCC probes are serialized: two concurrent model constructions crash the
// expo module event plumbing (observed on-sim; cheap insurance on device).
let pccQueue: Promise<unknown> = Promise.resolve();
const serialPccProbe = (question: string): ReturnType<typeof pccProbe> => {
  const next = pccQueue.then(() => pccProbe(question));
  pccQueue = next.catch(() => undefined);
  return next;
};

/** Availability report for the Settings row / diagnostics. */
export async function pccAvailability(): Promise<{ available: boolean; reason: string; contextSize: number }> {
  try {
    if (!pccEligible()) {
      const reason = Device.isDevice !== true ? 'simulator' : getOnDeviceAiAvailability();
      return { available: false, reason, contextSize: 0 };
    }
    const probe = await serialPccProbe('ping');
    return { available: probe.available, reason: probe.reason, contextSize: probe.contextSize ?? 0 };
  } catch {
    return { available: false, reason: 'error', contextSize: 0 };
  }
}

const INSTRUCTIONS =
  "You are SplitCircle's spending-insights writer. You receive precomputed " +
  'spending FACTS as JSON and write the short insight blurb shown at the top ' +
  "of the group's stats screen. Rules:\n" +
  '- Exactly 2-3 complete sentences of plain text. No lists, no markdown, no ' +
  'emoji, no preamble, no JSON.\n' +
  '- Use only numbers that appear in the FACTS, in the FACTS currency. You ' +
  'may round them, but never compute new totals or invent figures.\n' +
  '- Say what changed or stands out most, then end with one practical ' +
  'suggestion for the group.\n' +
  '- Friendly, concrete, specific.';

/** The facts ride the prompt; the persona rides `instructions` — never mixed. */
const factsPrompt = (facts: string): string =>
  `Write the insight blurb for these facts.\n\nFACTS (JSON, all numbers final):\n${facts}`;

// Session cache: facts-hash → narrative (models are expensive; stats reopen
// often). Only SUCCESSFUL narratives are cached — caching a null would pin
// "no narrative" for the whole session even after the model finishes warming
// up (availability is 'modelNotReady' for a while after boot).
const cache = new Map<string, InsightNarrative>();
// Session negative cache: keys whose narration ran with the model AVAILABLE
// and still produced nothing (sanitizer rejection). Greedy sampling makes
// that outcome deterministic — re-running the model each stats open would
// burn battery for the identical rejection. Warm-up nulls (modelNotReady)
// are NOT recorded here, so those retry naturally.
const nullCache = new Set<string>();
// In-flight dedupe: identical concurrent requests share one model call. Stats
// screens re-narrate when async loads (recurring bills) tweak the facts — the
// global FM queue serializes distinct calls, this collapses identical ones.
const inflight = new Map<string, Promise<InsightNarrative | null>>();

// Persistent cache (survives relaunch): the SAME facts must always show the
// SAME narrative — re-rolling a fresh narrative for unchanged data on every
// launch read as "inconsistent AI". Small FIFO map, newest last.
const STORE_KEY = 'insights_narrative_cache_v1';
const STORE_CAP = 32;
let storeLoad: Promise<Record<string, InsightNarrative>> | null = null;
const loadStore = (): Promise<Record<string, InsightNarrative>> => {
  storeLoad ??= AsyncStorage.getItem(STORE_KEY)
    .then((raw) => (raw ? (JSON.parse(raw) as Record<string, InsightNarrative>) : {}))
    .catch(() => ({}));
  return storeLoad;
};

async function readStored(key: string): Promise<InsightNarrative | null> {
  const store = await loadStore();
  const entry = store[key];
  const valid =
    entry &&
    typeof entry.text === 'string' &&
    entry.text &&
    (entry.source === 'ondevice' || entry.source === 'pcc');
  return valid ? entry : null;
}

async function writeStored(key: string, value: InsightNarrative): Promise<void> {
  try {
    const store = await loadStore();
    delete store[key]; // re-insert at the tail (FIFO recency)
    store[key] = value;
    const keys = Object.keys(store);
    while (keys.length > STORE_CAP) delete store[keys.shift() as string];
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Persistence is best-effort; the in-memory cache still holds the entry.
  }
}

const hash = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h);
};

/**
 * Narrate a facts blob. `deep: true` prefers PCC (whole-history analysis);
 * otherwise on-device is tried first. Returns null when no model is available
 * — the caller renders heuristic cards only.
 */
export async function narrateInsights(
  facts: string,
  opts: { deep?: boolean } = {},
): Promise<InsightNarrative | null> {
  // facts.length rides the key: with a persistent cache, a bare 32-bit hash
  // collision would show another facts blob's narrative.
  const key = `${opts.deep ? 'deep' : 'lite'}:${facts.length}:${hash(facts)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (nullCache.has(key)) return null;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    const stored = await readStored(key);
    if (stored) {
      cache.set(key, stored);
      return stored;
    }
    const result = await computeNarrative(facts, opts.deep === true);
    if (result) {
      cache.set(key, result);
      void writeStored(key, result);
    } else if (getOnDeviceAiAvailability() === 'available') {
      nullCache.add(key);
    }
    return result;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

async function computeNarrative(facts: string, deep: boolean): Promise<InsightNarrative | null> {
  const pccAllowed = await getPccEnabled();

  // Deep analysis prefers PCC's larger context; fall through to on-device.
  if (deep && pccAllowed) {
    const viaPcc = await tryPcc(facts);
    if (viaPcc) return viaPcc;
  }

  const viaDevice = await tryOnDevice(facts);
  if (viaDevice) return viaDevice;

  // Lite path may still escalate to PCC when on-device is unavailable.
  if (!deep && pccAllowed) {
    const viaPcc = await tryPcc(facts);
    if (viaPcc) return viaPcc;
  }

  return null;
}

async function tryOnDevice(facts: string): Promise<InsightNarrative | null> {
  try {
    if (getOnDeviceAiAvailability() !== 'available') return null;
    // generateText: persona in `instructions`, facts in the prompt, greedy
    // sampling — the Q&A door (askOnDevice) made the model deflect and drift.
    const raw = await generateOnDeviceText(factsPrompt(facts), INSTRUCTIONS, {
      deterministic: true,
    });
    const text = sanitizeNarrative(raw, facts);
    return text ? { source: 'ondevice', text } : null;
  } catch {
    return null;
  }
}

async function tryPcc(facts: string): Promise<InsightNarrative | null> {
  const raw = await tryPccPrompt(factsPrompt(facts), INSTRUCTIONS);
  const text = raw ? sanitizeNarrative(raw, facts) : null;
  return text ? { source: 'pcc', text } : null;
}

/**
 * Run an arbitrary assembled prompt through PCC with ALL the guards applied
 * (kill switch, device/eligibility gate, serialized construction). Returns the
 * answer text, or null when PCC is off/unavailable/failed — callers fall back.
 * This is the shared escalation door for the insights chat (doc 23); it stays
 * null-on-sim and null-until-enrollment by construction. `instructions` ride
 * the model's real instructions slot when given; '' keeps the doc-23 stateless
 * shape where the assembled prompt carries them.
 */
export async function tryPccPrompt(prompt: string, instructions = ''): Promise<string | null> {
  try {
    if (!(await getPccEnabled())) return null;
    if (!pccEligible()) return null;
    // pccAsk is already serialized by the module-level FM queue.
    const result = await pccAsk(prompt, instructions);
    if (!result?.available) return null;
    const text = (result.answer ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Test/diagnostics hook. */
export function clearInsightsNarrativeCache(): void {
  cache.clear();
  nullCache.clear();
  storeLoad = null;
  void AsyncStorage.removeItem(STORE_KEY).catch(() => undefined);
}
