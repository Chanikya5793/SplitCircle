/**
 * Unit tests for the pure call-history dedup/merge logic
 * (upsertCallHistory / isSameCall / mergeCallEntries). These pin the fix for
 * the "duplicate rows from temp/final call ids" bug: a single physical call is
 * often persisted twice — once under the CallKit placeholder UUID (temp) and
 * once under the Firebase call-session id (final) — and must collapse into one
 * row with the freshest outcome.
 */
import { describe, expect, it } from 'vitest';
import {
  DEDUP_WINDOW_MS,
  isSameCall,
  mergeCallEntries,
  upsertCallHistory,
  type CallHistoryEntry,
} from '../localCallStorage';

const makeEntry = (overrides: Partial<CallHistoryEntry> = {}): CallHistoryEntry => ({
  callId: 'call-1',
  chatId: 'chat-1',
  type: 'audio',
  direction: 'outgoing',
  otherParticipant: { userId: 'peer-1', displayName: 'Alice' },
  startedAt: 1_000_000,
  endedAt: 1_000_000,
  duration: 0,
  status: 'missed',
  ...overrides,
});

describe('isSameCall', () => {
  it('matches on identical callId', () => {
    const a = makeEntry({ callId: 'x' });
    const b = makeEntry({ callId: 'x', chatId: 'other', otherParticipant: { userId: 'z', displayName: 'Z' } });
    expect(isSameCall(a, b)).toBe(true);
  });

  it('matches temp vs final ids for the same peer/chat within the window', () => {
    const temp = makeEntry({ callId: 'temp-uuid', startedAt: 1_000_000 });
    const final = makeEntry({ callId: 'final-session', startedAt: 1_000_000 + DEDUP_WINDOW_MS });
    expect(isSameCall(temp, final)).toBe(true);
  });

  it('does not match when started beyond the window', () => {
    const a = makeEntry({ callId: 'a', startedAt: 1_000_000 });
    const b = makeEntry({ callId: 'b', startedAt: 1_000_000 + DEDUP_WINDOW_MS + 1 });
    expect(isSameCall(a, b)).toBe(false);
  });

  it('does not match different peers even within the window', () => {
    const a = makeEntry({ callId: 'a', otherParticipant: { userId: 'peer-1', displayName: 'A' } });
    const b = makeEntry({ callId: 'b', otherParticipant: { userId: 'peer-2', displayName: 'B' } });
    expect(isSameCall(a, b)).toBe(false);
  });

  it('does not match different chats even for the same peer', () => {
    const a = makeEntry({ callId: 'a', chatId: 'chat-1' });
    const b = makeEntry({ callId: 'b', chatId: 'chat-2' });
    expect(isSameCall(a, b)).toBe(false);
  });
});

describe('mergeCallEntries (newest wins)', () => {
  it('takes status/duration/callId from the record with the later endedAt', () => {
    const temp = makeEntry({
      callId: 'temp',
      startedAt: 1_000_000,
      endedAt: 1_000_000,
      duration: 0,
      status: 'missed',
    });
    const final = makeEntry({
      callId: 'final',
      startedAt: 1_000_500,
      endedAt: 1_030_000,
      duration: 30,
      status: 'completed',
    });

    const merged = mergeCallEntries(temp, final);
    expect(merged.callId).toBe('final');
    expect(merged.status).toBe('completed');
    expect(merged.duration).toBe(30);
    // Earliest known start is preserved.
    expect(merged.startedAt).toBe(1_000_000);
  });

  it('is order-independent about which record is newest', () => {
    const older = makeEntry({ callId: 'older', endedAt: 10, status: 'missed', duration: 0 });
    const newer = makeEntry({ callId: 'newer', endedAt: 99, status: 'completed', duration: 42 });

    const a = mergeCallEntries(older, newer);
    const b = mergeCallEntries(newer, older);
    expect(a.callId).toBe('newer');
    expect(b.callId).toBe('newer');
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
  });

  it('preserves the most complete peer identity across both records', () => {
    const temp = makeEntry({
      callId: 'temp',
      endedAt: 5,
      otherParticipant: { userId: 'peer-1', displayName: 'Unknown' },
    });
    const final = makeEntry({
      callId: 'final',
      endedAt: 10,
      otherParticipant: { userId: 'peer-1', displayName: 'Alice', photoURL: 'a.png' },
    });

    const merged = mergeCallEntries(temp, final);
    expect(merged.otherParticipant.displayName).toBe('Alice');
    expect(merged.otherParticipant.photoURL).toBe('a.png');
  });

  it('recovers a real name/photo even when the newest record lost them', () => {
    const named = makeEntry({
      callId: 'temp',
      endedAt: 5,
      otherParticipant: { userId: 'peer-1', displayName: 'Alice', photoURL: 'a.png' },
    });
    const finalBare = makeEntry({
      callId: 'final',
      endedAt: 10,
      otherParticipant: { userId: 'peer-1', displayName: 'Unknown' },
    });

    const merged = mergeCallEntries(named, finalBare);
    expect(merged.callId).toBe('final');
    expect(merged.otherParticipant.displayName).toBe('Alice');
    expect(merged.otherParticipant.photoURL).toBe('a.png');
  });
});

describe('upsertCallHistory', () => {
  it('adds a brand new call to the front (most recent first)', () => {
    const existing = [makeEntry({ callId: 'a', chatId: 'chat-a', otherParticipant: { userId: 'pa', displayName: 'A' } })];
    const next = upsertCallHistory(existing, makeEntry({ callId: 'b', chatId: 'chat-b', otherParticipant: { userId: 'pb', displayName: 'B' } }));
    expect(next).toHaveLength(2);
    expect(next[0].callId).toBe('b');
    expect(next[1].callId).toBe('a');
  });

  it('collapses a temp/final duplicate into a single merged row', () => {
    const temp = makeEntry({
      callId: 'temp-uuid',
      startedAt: 1_000_000,
      endedAt: 1_000_000,
      status: 'missed',
      duration: 0,
    });
    const final = makeEntry({
      callId: 'final-session',
      startedAt: 1_000_800,
      endedAt: 1_060_000,
      status: 'completed',
      duration: 60,
    });

    const afterTemp = upsertCallHistory([], temp);
    const afterFinal = upsertCallHistory(afterTemp, final);

    expect(afterFinal).toHaveLength(1);
    expect(afterFinal[0].callId).toBe('final-session');
    expect(afterFinal[0].status).toBe('completed');
    expect(afterFinal[0].duration).toBe(60);
    expect(afterFinal[0].startedAt).toBe(1_000_000);
  });

  it('updates in place when the exact callId already exists', () => {
    const existing = [
      makeEntry({ callId: 'a', chatId: 'chat-a', otherParticipant: { userId: 'pa', displayName: 'A' } }),
      makeEntry({ callId: 'b', chatId: 'chat-b', otherParticipant: { userId: 'pb', displayName: 'B' } }),
    ];
    const next = upsertCallHistory(existing, makeEntry({ callId: 'b', chatId: 'chat-b', otherParticipant: { userId: 'pb', displayName: 'B' }, status: 'completed', duration: 12, endedAt: 2_000_000 }));
    expect(next).toHaveLength(2);
    // 'b' keeps its index, so no reordering churn.
    expect(next[1].callId).toBe('b');
    expect(next[1].status).toBe('completed');
    expect(next[1].duration).toBe(12);
  });

  it('keeps distinct calls (different peers within window) as separate rows', () => {
    const first = makeEntry({ callId: 'a', startedAt: 1_000_000, otherParticipant: { userId: 'peer-1', displayName: 'A' } });
    const second = makeEntry({ callId: 'b', startedAt: 1_000_500, otherParticipant: { userId: 'peer-2', displayName: 'B' } });
    const next = upsertCallHistory([first], second);
    expect(next).toHaveLength(2);
  });

  it('trims to the last 100 records', () => {
    let history: CallHistoryEntry[] = [];
    for (let i = 0; i < 120; i++) {
      history = upsertCallHistory(
        history,
        makeEntry({
          callId: `call-${i}`,
          chatId: `chat-${i}`,
          startedAt: 1_000_000 + i * 10_000,
          otherParticipant: { userId: `peer-${i}`, displayName: `P${i}` },
        })
      );
    }
    expect(history).toHaveLength(100);
    // Newest (last inserted) sits at the front.
    expect(history[0].callId).toBe('call-119');
  });
});
