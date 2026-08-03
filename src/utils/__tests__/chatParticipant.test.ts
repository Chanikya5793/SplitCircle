/**
 * Participants written to Firestore must contain NO undefined-valued keys.
 *
 * Firestore's client SDK throws "Unsupported field value: undefined" on such a
 * key, and `ChatParticipant.photoURL` is optional. Every chat-creation path
 * built participants by spreading a source object — `photoURL: member.photoURL`
 * — so for any user without a profile photo the key existed with an `undefined`
 * value and the write threw before it left the device.
 *
 * You could therefore not start a group chat or a DM with anyone who had no
 * avatar. Reported from TestFlight as "Could not open chat, try again later" on
 * the friends tab, and as a completely dead button on a group.
 *
 * `toBeUndefined()` is NOT the assertion these need. `{}` and
 * `{ photoURL: undefined }` both satisfy it, and only the second one throws —
 * so these check key PRESENCE via `in` / `Object.keys`, which is the actual
 * distinction Firestore makes.
 */
import { describe, expect, it } from 'vitest';
import { toChatParticipant, toChatParticipants } from '@/utils/chatParticipant';

const hasUndefinedValue = (obj: object): boolean =>
  Object.values(obj).some((value) => value === undefined);

describe('toChatParticipant', () => {
  it('OMITS photoURL rather than setting it undefined', () => {
    const participant = toChatParticipant({ userId: 'u1' }, 'Someone');
    expect('photoURL' in participant).toBe(false);
    expect(hasUndefinedValue(participant)).toBe(false);
  });

  it('omits photoURL for null, the value `?? undefined` used to convert', () => {
    // `photoURL: user.photoURL ?? undefined` was in the source verbatim, and it
    // turns null — a perfectly storable value — into the one value the SDK
    // refuses.
    const participant = toChatParticipant({ userId: 'u1', photoURL: null }, 'Someone');
    expect('photoURL' in participant).toBe(false);
  });

  it('omits an empty-string photoURL, which is not a usable URL', () => {
    expect('photoURL' in toChatParticipant({ userId: 'u1', photoURL: '' }, 'Someone')).toBe(false);
  });

  it('keeps a real photoURL', () => {
    const participant = toChatParticipant(
      { userId: 'u1', photoURL: 'https://example.com/a.jpg' },
      'Someone',
    );
    expect(participant.photoURL).toBe('https://example.com/a.jpg');
  });

  it('never produces an empty displayName', () => {
    // A blank name renders as an unlabelled chip in money-attribution UI, which
    // doc 30 catalogues as the worst outcome of the empty-name family.
    for (const bad of [undefined, null, '', '   ']) {
      expect(toChatParticipant({ userId: 'u1', displayName: bad }, 'Someone').displayName)
        .toBe('Someone');
    }
  });

  it('trims a padded displayName rather than storing the padding', () => {
    expect(toChatParticipant({ userId: 'u1', displayName: '  Rose  ' }, 'X').displayName)
      .toBe('Rose');
  });

  it('defaults status, since it is required by the type', () => {
    expect(toChatParticipant({ userId: 'u1' }, 'Someone').status).toBe('offline');
  });

  it('produces a clean roster for a group of avatar-less members', () => {
    // The exact reported shape: a group whose members all render as initials.
    const roster = toChatParticipants(
      [
        { userId: 'a', displayName: 'asd' },
        { userId: 'b', displayName: 'Rose', photoURL: null },
      ],
      'Member',
    );
    expect(roster).toHaveLength(2);
    for (const participant of roster) {
      expect(hasUndefinedValue(participant)).toBe(false);
      expect('photoURL' in participant).toBe(false);
    }
  });

  it('is safe to re-apply to an already-built participant', () => {
    // Called on values that may themselves have come from a previous
    // conversion, so it has to be idempotent.
    const once = toChatParticipant({ userId: 'u1', photoURL: 'x' }, 'A');
    const twice = toChatParticipant(once, 'A');
    expect(twice).toEqual(once);
  });
});
