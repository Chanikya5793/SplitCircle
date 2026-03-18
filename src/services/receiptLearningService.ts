import AsyncStorage from '@react-native-async-storage/async-storage';

const LEARNING_KEY = 'receipt_learning_v1';
const STRICT_MODE_KEY = 'receipt_strict_review_mode_v1';
const MIN_CORRECTION_HITS = 2;
const MIN_DROP_HITS = 2;

export interface LearningScannedItem {
  name: string;
  price: number;
  confidence: number;
}

export interface LearningFinalItem {
  name: string;
  price: number;
}

export interface LearningAppliedItem {
  name: string;
  price: number;
  quantity: number;
  confidence: number;
  source: 'scan' | 'learned';
  originalName: string;
}

interface LearningEntry {
  to: string;
  count: number;
  updatedAt: number;
}

interface LearningProfile {
  version: 1;
  corrections: Record<string, LearningEntry>;
  dropped: Record<string, number>;
}

const defaultProfile = (): LearningProfile => ({
  version: 1,
  corrections: {},
  dropped: {},
});

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const merchantKey = (merchantName: string | null | undefined): string => {
  const normalized = normalize(merchantName ?? '');
  return normalized || 'global';
};

const correctionKey = (merchantName: string | null | undefined, fromName: string): string =>
  `${merchantKey(merchantName)}::${normalize(fromName)}`;

const isSamePrice = (a: number, b: number): boolean => Math.abs(a - b) <= 0.03;

const loadProfile = async (): Promise<LearningProfile> => {
  try {
    const raw = await AsyncStorage.getItem(LEARNING_KEY);
    if (!raw) return defaultProfile();
    const parsed = JSON.parse(raw) as LearningProfile;
    if (parsed.version !== 1 || !parsed.corrections || !parsed.dropped) {
      return defaultProfile();
    }
    return parsed;
  } catch {
    return defaultProfile();
  }
};

const saveProfile = async (profile: LearningProfile): Promise<void> => {
  try {
    await AsyncStorage.setItem(LEARNING_KEY, JSON.stringify(profile));
  } catch {
    // Non-blocking: learning storage should never break scan UX.
  }
};

export const getStrictReviewMode = async (): Promise<boolean> => {
  try {
    const raw = await AsyncStorage.getItem(STRICT_MODE_KEY);
    return raw === '1';
  } catch {
    return false;
  }
};

export const setStrictReviewMode = async (enabled: boolean): Promise<void> => {
  try {
    await AsyncStorage.setItem(STRICT_MODE_KEY, enabled ? '1' : '0');
  } catch {
    // Non-blocking user preference save.
  }
};

const toMerchantLabel = (rawMerchantKey: string): string => {
  if (rawMerchantKey === 'global') return 'Global';
  return rawMerchantKey
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

export interface LearningMerchantSummary {
  key: string;
  label: string;
  correctionCount: number;
  droppedCount: number;
}

export const listLearningMerchants = async (): Promise<LearningMerchantSummary[]> => {
  const profile = await loadProfile();
  const aggregates: Record<string, { correctionCount: number; droppedCount: number }> = {};

  Object.entries(profile.corrections).forEach(([key, value]) => {
    const merchant = key.split('::')[0] || 'global';
    if (!aggregates[merchant]) {
      aggregates[merchant] = { correctionCount: 0, droppedCount: 0 };
    }
    aggregates[merchant].correctionCount += value.count;
  });

  Object.entries(profile.dropped).forEach(([key, value]) => {
    const merchant = key.split('::')[0] || 'global';
    if (!aggregates[merchant]) {
      aggregates[merchant] = { correctionCount: 0, droppedCount: 0 };
    }
    aggregates[merchant].droppedCount += value;
  });

  return Object.entries(aggregates)
    .map(([merchantKeyValue, counts]) => ({
      key: merchantKeyValue,
      label: toMerchantLabel(merchantKeyValue),
      correctionCount: counts.correctionCount,
      droppedCount: counts.droppedCount,
    }))
    .sort((a, b) => (b.correctionCount + b.droppedCount) - (a.correctionCount + a.droppedCount));
};

export const resetLearningForMerchant = async (merchant: string): Promise<void> => {
  const profile = await loadProfile();
  const normalizedMerchant = normalize(merchant) || 'global';
  const nextCorrections: LearningProfile['corrections'] = {};
  const nextDropped: LearningProfile['dropped'] = {};

  Object.entries(profile.corrections).forEach(([key, value]) => {
    const merchantKeyPart = key.split('::')[0] || 'global';
    if (merchantKeyPart !== normalizedMerchant) {
      nextCorrections[key] = value;
    }
  });

  Object.entries(profile.dropped).forEach(([key, value]) => {
    const merchantKeyPart = key.split('::')[0] || 'global';
    if (merchantKeyPart !== normalizedMerchant) {
      nextDropped[key] = value;
    }
  });

  await saveProfile({
    version: 1,
    corrections: nextCorrections,
    dropped: nextDropped,
  });
};

export const applyReceiptLearning = async (
  merchantName: string | null | undefined,
  items: Array<{ name: string; price: number; quantity: number; confidence: number }>,
): Promise<LearningAppliedItem[]> => {
  const profile = await loadProfile();

  return items.reduce<LearningAppliedItem[]>((acc, item) => {
    const globalKey = correctionKey('global', item.name);
    const scopedKey = correctionKey(merchantName, item.name);
    const scopedCorrection = profile.corrections[scopedKey];
    const globalCorrection = profile.corrections[globalKey];

    const bestCorrection =
      scopedCorrection && scopedCorrection.count >= MIN_CORRECTION_HITS
        ? scopedCorrection
        : globalCorrection && globalCorrection.count >= MIN_CORRECTION_HITS
          ? globalCorrection
          : undefined;

    const scopedDrop = profile.dropped[scopedKey] ?? 0;
    const globalDrop = profile.dropped[globalKey] ?? 0;
    const dropHits = Math.max(scopedDrop, globalDrop);

    if (dropHits >= MIN_DROP_HITS && item.confidence < 0.78) {
      return acc;
    }

    if (bestCorrection && normalize(bestCorrection.to) !== normalize(item.name)) {
      acc.push({
        ...item,
        name: bestCorrection.to,
        confidence: Math.min(0.99, item.confidence + 0.08),
        source: 'learned',
        originalName: item.name,
      });
      return acc;
    }

    acc.push({
      ...item,
      source: 'scan',
      originalName: item.name,
    });
    return acc;
  }, []);
};

export const recordReceiptLearningFeedback = async (params: {
  merchantName: string | null | undefined;
  scannedItems: LearningScannedItem[];
  finalItems: LearningFinalItem[];
}): Promise<void> => {
  const { merchantName, scannedItems, finalItems } = params;
  if (!scannedItems.length) return;

  const profile = await loadProfile();
  const now = Date.now();

  const finalNormSet = new Set(finalItems.map((item) => normalize(item.name)).filter(Boolean));

  scannedItems.forEach((scanned, index) => {
    const fromNorm = normalize(scanned.name);
    if (!fromNorm) return;

    const byIndex = finalItems[index];
    const matchByIndex = byIndex && isSamePrice(scanned.price, byIndex.price) ? byIndex : undefined;

    let matchedFinal: LearningFinalItem | undefined = matchByIndex;
    if (!matchedFinal) {
      matchedFinal = finalItems.find((candidate) => isSamePrice(candidate.price, scanned.price));
    }

    if (matchedFinal) {
      const toNorm = normalize(matchedFinal.name);
      if (toNorm && toNorm !== fromNorm) {
        const scoped = correctionKey(merchantName, scanned.name);
        const prev = profile.corrections[scoped];
        profile.corrections[scoped] = {
          to: matchedFinal.name,
          count: (prev?.count ?? 0) + 1,
          updatedAt: now,
        };
      }
      return;
    }

    if (!finalNormSet.has(fromNorm) && scanned.confidence < 0.82) {
      const scoped = correctionKey(merchantName, scanned.name);
      profile.dropped[scoped] = (profile.dropped[scoped] ?? 0) + 1;
    }
  });

  await saveProfile(profile);
};
