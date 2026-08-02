/**
 * Every message status must render a DISTINCT mark (doc 35).
 *
 * Three hand-rolled copies of this renderer existed — in `MessageBubble`,
 * `AlbumBubble` and `MessageActionSheet` — and only the first knew about
 * `failed` and `undecryptable`. The other two used fall-through ternaries, so:
 *
 *   - an album whose send FAILED drew the same confident tick as a sent one;
 *   - a message whose bytes arrived but could not be decrypted drew a
 *     "delivered" tick in the action sheet, which is precisely the misreport
 *     doc 33 §4.3 added the `undecryptable` status to prevent;
 *   - a FAILED message's action sheet drew no status mark at all.
 *
 * None of that is a type error: a ternary that falls through is valid code, and
 * neither `tsc` nor any existing test looks at what gets drawn. So the guard
 * has to assert on the rendered output, and it asserts on the ACCESSIBILITY
 * LABEL rather than the icon name — the label is the user-facing claim, and a
 * wrong one is the actual bug here (telling someone a message was delivered
 * when it was not).
 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons/Ionicons', () => ({
  // Renders only the label, which is what this test asserts on; the real icon
  // font is irrelevant and its barrel drags in every other icon family.
  default: ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
    React.createElement('span', { 'aria-label': accessibilityLabel }),
}));

import { MessageStatusIndicator } from '../Chat/MessageStatusIndicator';

afterEach(cleanup);

const labelsFor = (props: React.ComponentProps<typeof MessageStatusIndicator>): string[] => {
  const { container } = render(<MessageStatusIndicator {...props} />);
  return Array.from(container.querySelectorAll('[aria-label]')).map(
    (node) => node.getAttribute('aria-label') ?? '',
  );
};

describe('message status marks', () => {
  it('distinguishes a failed send from a successful one', () => {
    expect(labelsFor({ status: 'failed' })).toEqual(['Not sent']);
    expect(labelsFor({ status: 'sent' })).toEqual(['Sent']);
  });

  it('does NOT claim delivery for an undecryptable message', () => {
    const labels = labelsFor({ status: 'undecryptable' });
    expect(labels).toHaveLength(1);
    // The bytes arrived, so this is not "not sent" either — but it must never
    // read as a plain delivered/read tick.
    expect(labels[0]).not.toMatch(/^(Delivered|Read|Sent)$/);
    expect(labels[0]).toMatch(/couldn’t open/);
  });

  it('renders a mark for every status, so none is silently invisible', () => {
    // 'failed' rendered NOTHING in the action-sheet copy: a message that never
    // sent looked identical to one still in flight.
    for (const status of ['sending', 'sent', 'delivered', 'read', 'failed', 'undecryptable'] as const) {
      expect(labelsFor({ status }).length, `${status} renders no mark`).toBeGreaterThan(0);
    }
  });

  it('gives each status a mark distinct from every other', () => {
    const labels = (['sending', 'sent', 'delivered', 'read', 'failed', 'undecryptable'] as const)
      .map((status) => labelsFor({ status }).join('|'));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('reports read only once a read receipt exists, not merely delivery', () => {
    expect(labelsFor({ status: 'delivered', deliveredCount: 2 })).toEqual(['Delivered']);
    expect(labelsFor({ status: 'delivered', deliveredCount: 2, readCount: 1 })).toEqual(['Read']);
  });
});
