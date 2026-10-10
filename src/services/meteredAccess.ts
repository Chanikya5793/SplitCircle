/**
 * One gate for every feature whose included uses are limited by plan.
 *
 *   const grant = await requestMeteredAccess({ featureId: 'ai.expense_on_device_turn', … });
 *   if (!grant) return;            // the user was told why; nothing ran
 *   try { await doTheWork(); finishMeteredAccess(grant, 'completed'); }
 *   catch (e) { finishMeteredAccess(grant, 'failed'); throw e; }
 *
 * The server owns the decision (authorizeMonetizedOperation): plan window,
 * free previews, credits. This module only turns that decision into UI —
 * reserve, ask before spending credits, explain an exhausted allowance — and
 * settles the reservation through the durable finalization queue, so a
 * failed or cancelled attempt never costs anything.
 *
 * Fail-open, deliberately and only for work that runs on this device: when
 * the access service cannot be reached (offline, outage, or a server that
 * predates a feature's enforcement), the work is local and costs the service
 * nothing, so blocking it would only punish people for bad signal. An
 * explicit denial from the server is always honoured.
 */
import type {
  ClientMeteredFeatureId,
  MonetizationExecutionRoute,
  MonetizedOperationAuthorization,
} from '@/models/monetization';
import { ROUTES } from '@/constants/routes';
import { navigationRef } from '@/navigation/navigationRef';
import { authorizeMonetizedOperation } from '@/services/monetizationService';
import { queueMonetizedOperationFinalization } from '@/services/monetizedOperationFinalizationQueue';
import { appAlert } from '@/utils/appAlert';
import { describeResetTime } from '@/utils/monetizationPresentation';
import { v4 as uuidv4 } from 'uuid';

export interface MeteredFeatureCopy {
  /** Plural noun for the allowance, e.g. "AI assistant messages". */
  allowance: string;
  /** What keeping the user's work looks like, e.g. "Your question is still here." */
  draftNote?: string;
}

export const METERED_FEATURE_COPY: Record<ClientMeteredFeatureId, MeteredFeatureCopy> = {
  'advanced_split.completion': {
    allowance: 'advanced splits',
    draftNote: 'Your expense draft is still here.',
  },
  'ai.expense_on_device_turn': {
    allowance: 'AI assistant messages',
    draftNote: 'Your message is still in the box.',
  },
  'insights.advanced_report': {
    allowance: 'AI insight reports',
    draftNote: 'Your charts and history stay available.',
  },
};

export interface MeteredGrant {
  ownerUid: string;
  operationId: string;
  /** Null when access was granted without a reservation (service unreachable). */
  authorizationId: string | null;
  decision: MonetizedOperationAuthorization | null;
}

export interface RequestMeteredAccessOptions {
  ownerUid: string | undefined;
  featureId: ClientMeteredFeatureId;
  executionRoute: MonetizationExecutionRoute;
  variant?: string;
  /** Reuse a caller's idempotency key (e.g. an expense requestId). */
  operationId?: string;
  /** Screen title to come back to from Plans & credits. */
  backTitle?: string;
  /**
   * Show the denial inline instead of an alert — for surfaces where a modal on
   * every attempt would nag (the search answer card).
   */
  onDenied?: (decision: MonetizedOperationAuthorization) => void;
}

const isExplicitDenial = (error: unknown): boolean => {
  const code = String((error as { code?: unknown })?.code ?? '').replace(/^functions\//, '');
  const reason = (error as { details?: { reasonCode?: unknown } })?.details?.reasonCode;
  // The service understood the request and refused it on its merits. Anything
  // else (unavailable, internal, deadline, an older server that does not know
  // this feature yet) says nothing about the user's allowance.
  return code === 'permission-denied'
    || code === 'unauthenticated'
    || (code === 'failed-precondition' && reason !== undefined && reason !== 'FEATURE_NOT_ENFORCED');
};

const confirm = (title: string, message: string, accept: string, reject: string): Promise<boolean> =>
  new Promise((resolve) => {
    appAlert(title, message, [
      { text: reject, style: 'cancel', onPress: () => resolve(false) },
      { text: accept, onPress: () => resolve(true) },
    ], { cancelable: false });
  });

const creditWord = (count: number) => (count === 1 ? 'Mana Credit' : 'Mana Credits');

export const openPlansAndCredits = (backTitle?: string): void => {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate(ROUTES.APP.PLANS_AND_CREDITS, { backTitle: backTitle ?? 'Back' });
};

export const openUsage = (backTitle?: string): void => {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate(ROUTES.APP.USAGE, { backTitle: backTitle ?? 'Back' });
};

/** Explains an exhausted allowance and offers the honest next steps. */
export const explainMeteredDenial = (
  featureId: ClientMeteredFeatureId | 'provider.security_check' | 'provider.manual_monitor_run',
  decision: Pick<MonetizedOperationAuthorization, 'creditCost' | 'creditBalance' | 'resetsAt' | 'planId'>,
  options: { allowance?: string; draftNote?: string; backTitle?: string } = {},
): void => {
  const copy = featureId in METERED_FEATURE_COPY
    ? METERED_FEATURE_COPY[featureId as ClientMeteredFeatureId]
    : undefined;
  const allowance = options.allowance ?? copy?.allowance ?? 'included uses';
  const draftNote = options.draftNote ?? copy?.draftNote;
  const reset = decision.resetsAt ? ` More become available ${describeResetTime(decision.resetsAt)}.` : '';
  const credits = decision.creditCost
    ? ` Each one costs ${decision.creditCost} ${creditWord(decision.creditCost)} after that; you have ${decision.creditBalance}.`
    : '';
  appAlert(
    `You've used your ${allowance}`,
    [`Your ${decision.planId === 'free' ? 'free plan' : 'plan'} includes a set number each period.${reset}${credits}`, draftNote]
      .filter(Boolean)
      .join('\n\n'),
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'See usage', onPress: () => openUsage(options.backTitle) },
      { text: 'Plans & credits', onPress: () => openPlansAndCredits(options.backTitle) },
    ],
  );
};

/**
 * Reserve one use before running the work. Resolves to null when the user
 * should not proceed (they have already been told why).
 */
export async function requestMeteredAccess(
  options: RequestMeteredAccessOptions,
): Promise<MeteredGrant | null> {
  const operationId = options.operationId ?? uuidv4();
  if (!options.ownerUid) {
    appAlert('Sign in required', 'Sign in again to continue.');
    return null;
  }
  const authorize = (useCredits: boolean) => authorizeMonetizedOperation({
    operationId,
    featureId: options.featureId,
    ...(options.variant ? { variant: options.variant } : {}),
    executionRoute: options.executionRoute,
    useCredits,
  });

  let decision: MonetizedOperationAuthorization;
  try {
    decision = await authorize(false);
    if (!decision.allowed && decision.reasonCode === 'credit_consent_required'
      && decision.creditCost !== null && decision.creditBalance >= decision.creditCost) {
      const copy = METERED_FEATURE_COPY[options.featureId];
      const approved = await confirm(
        'Use Mana Credits?',
        `Your included ${copy.allowance} are used up. This one costs ${decision.creditCost} ${creditWord(decision.creditCost)}; your balance is ${decision.creditBalance}. Credits are only spent if it succeeds.`,
        `Use ${decision.creditCost} ${decision.creditCost === 1 ? 'credit' : 'credits'}`,
        'Not now',
      );
      if (!approved) return null;
      decision = await authorize(true);
    }
  } catch (error) {
    if (isExplicitDenial(error)) {
      appAlert('Could not check your plan', 'Sign in again, then try once more.');
      return null;
    }
    console.error('[meteredAccess] access service unavailable; running locally', options.featureId, error);
    return { ownerUid: options.ownerUid, operationId, authorizationId: null, decision: null };
  }

  if (!decision.allowed || !decision.authorizationId) {
    if (options.onDenied) options.onDenied(decision);
    else explainMeteredDenial(options.featureId, decision, { backTitle: options.backTitle });
    return null;
  }
  return {
    ownerUid: options.ownerUid,
    operationId,
    authorizationId: decision.authorizationId,
    decision,
  };
}

/**
 * Settle a reservation. `completed` consumes the use; anything else releases
 * it (and refunds any credits it held). Durable: survives an app restart.
 */
export function finishMeteredAccess(
  grant: MeteredGrant | null,
  outcome: 'completed' | 'failed' | 'cancelled',
): void {
  if (!grant?.authorizationId) return;
  void queueMonetizedOperationFinalization(grant.ownerUid, {
    operationId: grant.operationId,
    authorizationId: grant.authorizationId,
    outcome,
  }).catch((error) => {
    console.error('[meteredAccess] could not queue finalization', error);
  });
}

type ServerMeteredFeatureId = 'provider.security_check' | 'provider.manual_monitor_run';

const SERVER_FEATURE_COPY: Record<ServerMeteredFeatureId, { allowance: string; one: string }> = {
  'provider.security_check': { allowance: 'link safety checks', one: 'check' },
  'provider.manual_monitor_run': { allowance: 'manual security scans', one: 'scan' },
};

/** The quota decision a metered callable attaches to `resource-exhausted`. */
const quotaDecisionOf = (error: unknown): MonetizedOperationAuthorization | null => {
  const code = String((error as { code?: unknown })?.code ?? '').replace(/^functions\//, '');
  if (code !== 'resource-exhausted') return null;
  const decision = (error as { details?: { monetization?: unknown } })?.details?.monetization;
  return decision && typeof decision === 'object'
    ? decision as MonetizedOperationAuthorization
    : null;
};

/**
 * Run a callable that meters itself on the server (provider-backed work).
 * On an exhausted allowance it asks before spending credits and retries the
 * SAME attempt, or explains the limit. Resolves to null when nothing ran.
 * Errors that are not about the allowance (for example a safety cool-down)
 * are rethrown for the caller to show.
 */
export async function runServerMeteredCall<T>(
  featureId: ServerMeteredFeatureId,
  call: (useCredits: boolean) => Promise<T>,
  options: { backTitle?: string } = {},
): Promise<T | null> {
  try {
    return await call(false);
  } catch (error) {
    const decision = quotaDecisionOf(error);
    if (!decision) throw error;
    const copy = SERVER_FEATURE_COPY[featureId];
    if (decision.reasonCode === 'credit_consent_required'
      && decision.creditCost !== null && decision.creditBalance >= decision.creditCost) {
      const approved = await confirm(
        'Use Mana Credits?',
        `Your included ${copy.allowance} are used up. This ${copy.one} costs ${decision.creditCost} ${creditWord(decision.creditCost)}; your balance is ${decision.creditBalance}. Credits are only spent if it succeeds.`,
        `Use ${decision.creditCost} ${decision.creditCost === 1 ? 'credit' : 'credits'}`,
        'Not now',
      );
      if (!approved) return null;
      try {
        return await call(true);
      } catch (retryError) {
        const retryDecision = quotaDecisionOf(retryError);
        if (!retryDecision) throw retryError;
        explainMeteredDenial(featureId, retryDecision, { allowance: copy.allowance, backTitle: options.backTitle });
        return null;
      }
    }
    explainMeteredDenial(featureId, decision, { allowance: copy.allowance, backTitle: options.backTitle });
    return null;
  }
}
