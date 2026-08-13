/**
 * deepLinkService.ts — routes `splitcircle://` deep links into the app's navigation.
 *
 * Two entry channels, both funnel through `handleUrl`:
 *  1. **Pending link from an App Intent / Siri** — an in-process App Intent stashes a
 *     URL in `UserDefaults.standard` under `SplitCirclePendingDeepLink`
 *     (SplitCircleSharedStore.setPendingDeepLink). Since those intents run in the app
 *     process, react-native `Settings` reads the same defaults. We drain it on mount
 *     and on every foreground, and only clear it AFTER a successful navigate so a link
 *     that arrives while signed-out survives to the next foreground.
 *  2. **Real URL opens** — a widget tap (`.widgetURL`/`Link`) or Spotlight result opens
 *     `splitcircle://…` through the OS; `Linking` delivers it here.
 *
 * Supported URLs (authored in SplitCircleIntents.swift + BalanceWidget.swift):
 *   splitcircle://group/<groupId>
 *   splitcircle://groups
 *   splitcircle://add-expense?group=<id>&amount=<n>&title=<t>&split=<method>&participants=<uid,uid>
 *   splitcircle://settle?group=<id>
 *   splitcircle://ask?group=<id>&q=<question>
 *   splitcircle://security
 *
 * Best-effort: never throws into React. Navigation failures (e.g. target not mounted
 * yet) leave a pending link in place to retry.
 */

import { useEffect } from 'react';
import { AppState, Linking, Platform, Settings } from 'react-native';
import { navigationRef } from '@/navigation/navigationRef';
import { ROUTES } from '@/constants/routes';

const PENDING_KEY = 'SplitCirclePendingDeepLink';

/** Read the pending-deep-link value stashed by an App Intent (iOS only). */
function readPendingLink(): string | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const v = Settings.get(PENDING_KEY);
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function clearPendingLink(): void {
  if (Platform.OS !== 'ios') return;
  try {
    Settings.set({ [PENDING_KEY]: '' });
  } catch {
    // best-effort
  }
}

/**
 * Self-contained parser for `splitcircle://<host>/<segments>?<query>`. Deliberately
 * NOT using the global `URL`: React Native's built-in `URL` polyfill is incomplete
 * (no reliable `searchParams`, shaky host parsing for non-http schemes), and the rest
 * of this codebase only ever uses `URL` for http(s). A silent parse failure here would
 * break every deep link, so we parse the string directly.
 */
function parseDeepLink(
  rawUrl: string,
): { host: string; segments: string[]; query: Record<string, string> } | null {
  const m = /^splitcircle:\/\/([^?]*)(?:\?(.*))?$/i.exec(rawUrl.trim());
  if (!m) return null;
  const parts = (m[1] || '').split('/').filter(Boolean);
  const query: Record<string, string> = {};
  for (const pair of (m[2] || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const val = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      query[decodeURIComponent(key)] = decodeURIComponent(val.replace(/\+/g, ' '));
    } catch {
      query[key] = val;
    }
  }
  return { host: parts[0] ?? '', segments: parts.slice(1), query };
}

/**
 * Parse + navigate. Returns true only if a known route was reached, so the caller
 * knows whether it's safe to clear a pending link.
 */
export function handleUrl(rawUrl: string): boolean {
  if (!rawUrl || !navigationRef.isReady()) return false;

  const link = parseDeepLink(rawUrl);
  if (!link) return false;
  const { host, segments, query } = link;

  try {
    switch (host) {
      case 'group': {
        const groupId = segments[0] ?? query.group ?? '';
        if (!groupId) return false;
        navigationRef.navigate(ROUTES.APP.ROOT, {
          screen: ROUTES.APP.GROUPS_TAB,
          params: { screen: ROUTES.APP.GROUP_DETAILS, params: { groupId } },
        });
        return true;
      }
      case 'groups': {
        navigationRef.navigate(ROUTES.APP.ROOT, { screen: ROUTES.APP.GROUPS_TAB });
        return true;
      }
      case 'add-expense': {
        const groupId = query.group ?? '';
        if (!groupId) return false;
        navigationRef.navigate(ROUTES.APP.ADD_EXPENSE, {
          groupId,
          initialAmount: query.amount,
          initialTitle: query.title,
          initialSplitMethod: query.split,
          initialParticipants: query.participants
            ? query.participants.split(',').filter(Boolean)
            : undefined,
        });
        return true;
      }
      case 'settle': {
        const groupId = query.group ?? '';
        if (!groupId) return false;
        navigationRef.navigate(ROUTES.APP.SETTLEMENTS, { groupId });
        return true;
      }
      case 'ask': {
        const groupId = query.group ?? '';
        if (!groupId) return false;
        navigationRef.navigate(ROUTES.APP.ASK_AI, {
          groupId,
          initialQuestion: query.q,
        });
        return true;
      }
      case 'security': {
        navigationRef.navigate(ROUTES.APP.SECURITY_CENTER, {
          backTitle: 'Settings',
        });
        return true;
      }
      default:
        return false;
    }
  } catch {
    // Target not mounted / bad params — leave any pending link for a later retry.
    return false;
  }
}

/** Drain a pending App-Intent link, if one is waiting. */
function drainPending(): void {
  const pending = readPendingLink();
  if (pending && handleUrl(pending)) {
    clearPendingLink();
  }
}

/**
 * Hook: wires deep-link handling for the lifetime of the signed-in nav tree.
 * Mount once (see DeepLinkHandler in AppNavigator).
 */
export function useDeepLinks(): void {
  useEffect(() => {
    // 1. Cold-start URL (widget/Spotlight launched the app).
    void Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });
    // 2. Cold-start pending App-Intent link. Slight delay so the nav tree finishes
    //    mounting before we navigate (isReady guards, but the target screens need to
    //    exist too).
    const t = setTimeout(drainPending, 350);

    // 3. Warm URL opens.
    const linkSub = Linking.addEventListener('url', ({ url }) => handleUrl(url));

    // 4. Every foreground: an App Intent may have just stashed a pending link, or a
    //    widget tap may have brought us forward.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') drainPending();
    });

    return () => {
      clearTimeout(t);
      linkSub.remove();
      appStateSub.remove();
    };
  }, []);
}
