/**
 * Origin re-seal (ai_layer/docs/33 §2.5, Phase 8).
 *
 * Doc 32 §5e documented that a device added to a thread AFTER an envelope was
 * sealed can never receive it: relays forward frozen ciphertext, and the new
 * device has no copy addressed to it. A real router makes this worse — more
 * hops means more chances to be the excluded node — so doc 33 adopted the
 * re-seal path §5e had deferred.
 *
 * THE RULE THAT CANNOT BEND: only the ORIGIN re-seals. A relay minting
 * ciphertext attributed to another sender is forgery, and `originOwned`
 * (doc 32 §5a) is the guard. The cost is that re-sealing needs the origin to
 * be reachable; store-and-forward covers that gap.
 *
 * This module is the DECISION half — pure, no crypto, no I/O — so the rule can
 * be tested exhaustively without a device. The rebuild half belongs with
 * whatever owns the keys.
 */

import { MAX_MESH_MESSAGE_AGE_MS } from '@/services/mesh/constants';

export interface ResealCandidate {
  /** False for anything we relayed rather than authored. */
  originOwned: boolean;
  /** Device ids the existing envelope actually carries a copy for. */
  recipientDeviceIds?: string[];
  wireEnvelope?: string;
  createdAt: number;
}

export type ResealVerdict =
  | { reseal: true; missingDeviceIds: string[] }
  | {
    reseal: false;
    reason: 'not-origin-owned' | 'no-envelope' | 'too-old' | 'already-covered';
  };

/**
 * Decides whether this operation should be re-sealed for devices it does not
 * yet cover.
 *
 * Order matters: `not-origin-owned` is checked FIRST and unconditionally, so no
 * later condition can ever accidentally admit a relayed message. That ordering
 * is the forgery guard, not a style choice.
 */
export const evaluateReseal = (
  operation: ResealCandidate,
  currentAudienceDeviceIds: readonly string[],
  now: number = Date.now(),
  maxAgeMs: number = MAX_MESH_MESSAGE_AGE_MS,
): ResealVerdict => {
  if (!operation.originOwned) return { reseal: false, reason: 'not-origin-owned' };
  if (!operation.wireEnvelope) return { reseal: false, reason: 'no-envelope' };

  // Bounded by the same 7-day window the queue itself uses. Without this, a
  // device joining a group would trigger a re-seal of every message ever
  // queued — a flood, and an unpleasant surprise for someone who joined a
  // conversation expecting to start from now.
  if (now - operation.createdAt > maxAgeMs) return { reseal: false, reason: 'too-old' };

  const sealed = new Set(operation.recipientDeviceIds ?? []);
  const missing = [...new Set(currentAudienceDeviceIds)].filter((id) => !sealed.has(id));
  if (missing.length === 0) return { reseal: false, reason: 'already-covered' };

  return { reseal: true, missingDeviceIds: missing };
};

/**
 * Devices that dropped out of the audience since sealing.
 *
 * Reported but deliberately NOT acted on. Removing a device from an existing
 * envelope would rewrite history, and the ciphertext already sealed for it may
 * have been delivered. Departure is handled by the thread audience, not by
 * rewriting messages — this exists so a diagnostic can show the drift rather
 * than to drive a mutation.
 */
export const departedDevices = (
  operation: ResealCandidate,
  currentAudienceDeviceIds: readonly string[],
): string[] => {
  const current = new Set(currentAudienceDeviceIds);
  return (operation.recipientDeviceIds ?? []).filter((id) => !current.has(id));
};
