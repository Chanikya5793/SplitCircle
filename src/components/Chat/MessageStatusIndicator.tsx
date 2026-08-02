/**
 * The one place a message's send status becomes a tick (doc 35).
 *
 * Extracted from `MessageBubble` because there was a SECOND, hand-rolled copy
 * in `AlbumBubble` that had never been updated: its ternary chain knew only
 * read/delivered/sending and fell through to a plain single tick for everything
 * else. So an album whose send FAILED, or whose bytes arrived but could not be
 * decrypted, displayed the same confident "sent" tick as a healthy one — the
 * exact misreport doc 33 §4.3 introduced the `undecryptable` status to prevent.
 *
 * Two renderers for one concept is the defect. A `MessageStatus` union member
 * added later cannot be handled in both by accident, and neither compiler nor
 * test flags the one that was missed, because a fall-through ternary is
 * perfectly valid code. Both call sites now share this.
 */
// Subpath, not the barrel: `@expo/vector-icons` pulls in every icon family,
// which breaks any test that renders this without mocking all of them.
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import type { MessageStatus } from '@/models';

interface MessageStatusIndicatorProps {
  status: MessageStatus;
  /** Read receipts seen so far. Group chats aggregate; 1:1 uses `status`. */
  deliveredCount?: number;
  readCount?: number;
}

export const MessageStatusIndicator = ({
  status,
  deliveredCount,
  readCount,
}: MessageStatusIndicatorProps) => {
  const delivered = deliveredCount ?? 0;
  const read = readCount ?? 0;

  if (status === 'sending') {
    return (
      <Ionicons
        name="time-outline"
        size={14}
        color="rgba(255,255,255,0.6)"
        style={styles.statusIconSingle}
        accessibilityLabel="Sending"
      />
    );
  }

  if (status === 'failed') {
    return (
      <Ionicons
        name="alert-circle-outline"
        size={14}
        color="#FF6B6B"
        style={styles.statusIconSingle}
        accessibilityLabel="Not sent"
      />
    );
  }

  // ARRIVED BUT UNREADABLE (doc 33 §4.3) — deliberately NOT the same as failed.
  // The bytes reached the other phone and proved authentic; it just could not
  // open them. Red "not sent" would invite a resend of something that already
  // travelled, and hide that the real repair is the session rebuild the app now
  // performs automatically on this signal. Amber, not red: something is wrong,
  // but nothing was lost.
  if (status === 'undecryptable') {
    return (
      <Ionicons
        name="alert-circle-outline"
        size={14}
        color="#FFB020"
        style={styles.statusIconSingle}
        accessibilityLabel="Delivered, but the other device couldn’t open it"
      />
    );
  }

  const hasAnyRead = read > 0 || status === 'read';
  const hasAnyDelivered = hasAnyRead || delivered > 0 || status === 'delivered';

  if (!hasAnyDelivered) {
    return (
      <Ionicons
        name="checkmark"
        size={14}
        color="rgba(255,255,255,0.7)"
        style={styles.statusIconSingle}
        accessibilityLabel="Sent"
      />
    );
  }

  const tickColor = hasAnyRead ? '#35C6FF' : 'rgba(255,255,255,0.7)';
  return (
    <View
      style={styles.statusDoubleTick}
      accessibilityLabel={hasAnyRead ? 'Read' : 'Delivered'}
    >
      <Ionicons name="checkmark" size={13} color={tickColor} style={styles.statusTickBack} />
      <Ionicons name="checkmark" size={13} color={tickColor} style={styles.statusTickFront} />
    </View>
  );
};

const styles = StyleSheet.create({
  statusIconSingle: {
    marginLeft: 4,
  },
  statusDoubleTick: {
    marginLeft: 4,
    flexDirection: 'row',
    alignItems: 'center',
    width: 18,
  },
  statusTickBack: {
    marginRight: -6,
  },
  statusTickFront: {
    marginLeft: 0,
  },
});
