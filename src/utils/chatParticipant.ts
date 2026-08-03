/**
 * Firestore-safe `ChatParticipant` construction.
 *
 * THE BUG THIS EXISTS FOR. Firestore's client SDK THROWS on a field whose value
 * is `undefined` — "Unsupported field value: undefined" — unless
 * `ignoreUndefinedProperties` is set, which this project did not set. Both
 * chat-creation paths built participants as
 * `{ userId, displayName, photoURL: member.photoURL, status }`, and `photoURL`
 * is optional. So for any user without a profile photo the key was present with
 * an `undefined` value and the write threw before it ever reached the server.
 *
 * The result: you could not start a chat with anyone who had no avatar. On the
 * friends tab that surfaced as "Could not open chat — please try again in a
 * moment", which is doubly wrong because retrying can never help. On a group it
 * surfaced as nothing at all, because that caller only logged to the console.
 *
 * `undefined` is not the same as absent to this SDK, and an optional field
 * spread from a source object is the ordinary way to produce one — which is why
 * this is a shared helper rather than a fix at each call site. There were six
 * such call sites and exactly one of them (`callService`) had it right.
 */
import type { ChatParticipant, PresenceStatus } from '@/models';

interface ParticipantSource {
  userId: string;
  displayName?: string | null;
  photoURL?: string | null;
  status?: PresenceStatus;
}

/**
 * Builds a participant with NO undefined-valued keys.
 *
 * `photoURL` is omitted entirely when absent rather than set to null: the field
 * is declared optional, and writing an explicit null would make every
 * avatar-less participant carry a field that reads as "explicitly has no photo"
 * rather than "not set".
 */
export const toChatParticipant = (
  source: ParticipantSource,
  fallbackName: string,
): ChatParticipant => {
  const displayName = source.displayName?.trim();
  return {
    userId: source.userId,
    // Never empty: an unnamed participant renders as a blank chip in
    // money-attribution UI, which doc 30 catalogues as the worst class of bug
    // that family produces.
    displayName: displayName && displayName.length > 0 ? displayName : fallbackName,
    status: source.status ?? 'offline',
    ...(source.photoURL ? { photoURL: source.photoURL } : {}),
  };
};

/** Same guarantee for a whole roster. */
export const toChatParticipants = (
  sources: readonly ParticipantSource[],
  fallbackName: string,
): ChatParticipant[] => sources.map((source) => toChatParticipant(source, fallbackName));
