import { useSendProgress } from '@/hooks/useSendProgress';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

interface SendProgressOverlayProps {
  /** Same value as the pipeline's requestId — the key progress is stored under. */
  messageId: string;
}

const RING_SIZE = 54;
const RING_STROKE = 3;
const RADIUS = (RING_SIZE - RING_STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The in-bubble progress ring for a media message that is still being sent.
 *
 * Replaces a bare indeterminate `ActivityIndicator`, which could not
 * distinguish "compressing", "uploading steadily" and "stalled" — the three
 * states a user most needs told apart, and the reason a working send read as
 * a frozen one. Compression and upload each report a real fraction, so the
 * ring is determinate for the entire span where the app actually knows how
 * far along it is.
 *
 * The ring doubles as the Cancel target: tapping it aborts the item. The
 * control disappears once the send passes the point of no return (fan-out to
 * recipients), because offering Cancel there would promise an undo that
 * cannot be honoured.
 */
export const SendProgressOverlay = ({ messageId }: SendProgressOverlayProps) => {
  const progress = useSendProgress(messageId);

  // No entry means this message is not in the pipeline — an older 'sending'
  // bubble left behind by a killed app, for instance. Render nothing extra
  // and let the caller's own spinner stand.
  if (!progress) return null;

  const { stage, fraction, bytesSent, bytesTotal, cancel } = progress;

  const label = (() => {
    switch (stage) {
      case 'queued':
        return 'Waiting…';
      case 'compressing':
        return fraction === null
          ? 'Preparing…'
          : `Preparing ${Math.round(fraction * 100)}%`;
      case 'uploading':
        if (bytesSent !== undefined && bytesTotal !== undefined && bytesTotal > 0) {
          return `${formatBytes(bytesSent)} / ${formatBytes(bytesTotal)}`;
        }
        return fraction === null ? 'Uploading…' : `Uploading ${Math.round(fraction * 100)}%`;
      case 'sending':
        return 'Sending…';
      case 'failed':
        return 'Failed';
      default:
        return null;
    }
  })();

  // An indeterminate stage draws a fixed 25% arc rather than a full ring, so
  // it still reads as "in progress" without claiming a completion figure the
  // pipeline does not have.
  const shown = fraction === null ? 0.25 : Math.max(0, Math.min(1, fraction));
  const dashOffset = CIRCUMFERENCE * (1 - shown);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Pressable
        onPress={cancel}
        disabled={!cancel}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={cancel ? 'Cancel sending this item' : 'Sending'}
        style={styles.ringWrap}
      >
        <Svg width={RING_SIZE} height={RING_SIZE}>
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            stroke="rgba(255,255,255,0.28)"
            strokeWidth={RING_STROKE}
            fill="none"
          />
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            stroke="#fff"
            strokeWidth={RING_STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeDashoffset={dashOffset}
            // Start the arc at 12 o'clock instead of 3 o'clock.
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </Svg>
        {cancel ? (
          <View style={styles.ringCenter}>
            <Ionicons name="close" size={22} color="#fff" />
          </View>
        ) : null}
      </Pressable>
      {label ? (
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    gap: 8,
  },
  ringWrap: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
    overflow: 'hidden',
  },
});
