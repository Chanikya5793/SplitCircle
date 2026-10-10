/**
 * The AI narrative on the stats screens, metered as an "AI insight report".
 *
 * A narrative already generated for the same facts is shown for free. A new
 * one is generated automatically only when the plan makes reports unlimited
 * (or for internal testers); otherwise the screen offers an explicit
 * Generate action, so flipping the date range never silently spends someone's
 * allowance (monetization blueprint: "make model generation an explicit
 * Generate or Refresh action before metering it").
 */
import { useAuth } from '@/context/AuthContext';
import { useMonetizationPurchases } from '@/context/MonetizationPurchaseContext';
import {
  narrateInsights,
  narrativeModelAvailable,
  peekNarrative,
  type InsightNarrative,
} from '@/services/insightsAiService';
import { finishMeteredAccess, requestMeteredAccess } from '@/services/meteredAccess';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface InsightNarrativeState {
  narrative: InsightNarrative | null;
  loading: boolean;
  /** A model is available and nothing is cached: offer Generate. */
  canGenerate: boolean;
  /** Set when the allowance is used up; when it comes back (null = unknown). */
  limitedUntil: number | null | undefined;
  generate: () => Promise<void>;
}

export function useInsightNarrative(
  facts: string | null,
  opts: { deep?: boolean; backTitle: string },
): InsightNarrativeState {
  const { user } = useAuth();
  const { snapshot } = useMonetizationPurchases();
  const [narrative, setNarrative] = useState<InsightNarrative | null>(null);
  const [loading, setLoading] = useState(false);
  const [canGenerate, setCanGenerate] = useState(false);
  const [limitedUntil, setLimitedUntil] = useState<number | null | undefined>(undefined);
  const generation = useRef(0);
  const deep = opts.deep === true;

  const rule = snapshot?.catalog.features['insights.advanced_report']?.quotaByPlan[snapshot.account.planId];
  const autoGenerate = snapshot !== null
    && (snapshot.account.access.commercialQuotaBypass || rule?.kind === 'unlimited_local');

  const generate = useCallback(async () => {
    if (!facts) return;
    const run = ++generation.current;
    setLimitedUntil(undefined);
    const grant = await requestMeteredAccess({
      ownerUid: user?.userId,
      featureId: 'insights.advanced_report',
      executionRoute: 'on_device_apple',
      backTitle: opts.backTitle,
      onDenied: (decision) => {
        if (run === generation.current) setLimitedUntil(decision.resetsAt);
      },
    });
    if (!grant) return;
    if (run !== generation.current) {
      finishMeteredAccess(grant, 'cancelled');
      return;
    }
    setLoading(true);
    setCanGenerate(false);
    try {
      const result = await narrateInsights(facts, { deep });
      finishMeteredAccess(grant, result ? 'completed' : 'failed');
      if (run === generation.current) setNarrative(result);
    } catch {
      finishMeteredAccess(grant, 'failed');
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [deep, facts, opts.backTitle, user?.userId]);

  useEffect(() => {
    const run = ++generation.current;
    setNarrative(null);
    setCanGenerate(false);
    setLimitedUntil(undefined);
    setLoading(false);
    if (!facts) return;
    void (async () => {
      const cached = await peekNarrative(facts, { deep });
      if (run !== generation.current) return;
      if (cached) {
        setNarrative(cached);
        return;
      }
      if (!(await narrativeModelAvailable()) || run !== generation.current) return;
      if (autoGenerate) void generate();
      else setCanGenerate(true);
    })();
    // `generate` is recreated with facts; depending on it would double-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, deep, autoGenerate]);

  return { narrative, loading, canGenerate, limitedUntil, generate };
}
