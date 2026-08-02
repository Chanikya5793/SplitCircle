/**
 * What each nearby route is doing, in words a person can act on.
 *
 * Pure module — no React and no native imports — so the wording and the
 * precedence between "connected", "not in this build" and "radio off" can be
 * tested directly. It lived inside `NearbyMessagingSheet` first, which meant the
 * only way to check it was to render the sheet.
 *
 * This replaces a static "Wi-Fi on / Bluetooth on / Apps open" checklist that
 * was user-verified and only turned green once something connected. That
 * checklist could not express the case that actually happens — one route
 * working and another off — so when nothing connected, both phones showed an
 * identical, unactionable screen and there was no way to tell a broken radio
 * from an absent peer.
 */
import type { MeshDiagnostics } from '@/services/mesh/diagnostics';
import type { TransportId } from '@/services/mesh/transport';

export type RouteTone = 'success' | 'neutral' | 'warning';

export interface RouteStatus {
  id: TransportId;
  /** The route as a user thinks of it, not the technology's name. */
  name: string;
  detail: string;
  tone: RouteTone;
  /** True when this row should render a tick instead of its own icon. */
  connected: boolean;
}

const NAMES: Record<TransportId, string> = {
  mpc: 'Apple Direct',
  lan: 'Wi-Fi',
  ble: 'Bluetooth',
};

/** Switch preference order, so the list reads the way traffic is actually routed. */
const ORDER: TransportId[] = ['mpc', 'lan', 'ble'];

export const describeRoutes = (
  /**
   * Live peers per transport. The ONLY source that knows about BLE and LAN —
   * the rest of the nearby snapshot is fed by an iOS-only native event.
   */
  transportPeers: Partial<Record<TransportId, string[]>> | undefined,
  diagnostics: Pick<MeshDiagnostics, 'transports' | 'bleEnabled' | 'lanEnabled'> | null,
  isIos: boolean,
): RouteStatus[] => {
  const inBuild: Record<TransportId, boolean> = {
    // MultipeerConnectivity is Apple-proprietary and can never reach Android
    // (doc 33 §0).
    mpc: isIos,
    ble: diagnostics?.bleEnabled ?? false,
    lan: diagnostics?.lanEnabled ?? false,
  };

  return ORDER
    // Filtered out rather than shown as unavailable: on Android that is a
    // permanent property of the platform, and listing it reads as a fault the
    // user might try to fix.
    .filter((id) => !(id === 'mpc' && !isIos))
    .map((id) => {
      const peers = transportPeers?.[id] ?? [];
      // Connected FIRST, whatever anything else says. A route carrying messages
      // is carrying messages.
      if (peers.length > 0) {
        return {
          id,
          name: NAMES[id],
          detail: `${peers.length} ${peers.length === 1 ? 'phone' : 'phones'} connected`,
          tone: 'success' as const,
          connected: true,
        };
      }
      if (!inBuild[id]) {
        return {
          id,
          name: NAMES[id],
          detail: 'Not included in this build',
          // Neutral, not a warning: nothing is wrong and there is nothing to do.
          tone: 'neutral' as const,
          connected: false,
        };
      }
      const view = diagnostics?.transports.find((entry) => entry.id === id);
      if (view && !view.available) {
        return {
          id,
          name: NAMES[id],
          detail: id === 'lan'
            ? 'Off — join a Wi-Fi network'
            : 'Off — turn the radio on and allow nearby access',
          tone: 'warning' as const,
          connected: false,
        };
      }
      return {
        id,
        name: NAMES[id],
        detail: 'On — no phones found yet',
        tone: 'neutral' as const,
        connected: false,
      };
    });
};
