import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatParticipant, MediaMetadata } from '@/models';
import { ROUTES } from '@/constants';
import { mediaExistsLocally, getOrDownloadMedia } from '@/services/mediaService';
import { markMessageDeletedForUser, unmarkMessageDeletedForUser } from '@/services/localMessageStorage';
import { warningHaptic } from '@/utils/haptics';
import { useVideoThumbnail } from '@/utils/videoThumbnail';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Image,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Snackbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── constants ───────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const GRID_GAP = 2;
const CELL_SIZE = (SCREEN_WIDTH - GRID_GAP * (COLUMN_COUNT + 1)) / COLUMN_COUNT;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
// Reserve a little space at the top so native player chrome doesn't get hidden under
// the close/info buttons. Smaller than before — the chrome bar fades out automatically.
const VIDEO_TOP_INSET = 0;
// Bottom thumbnail strip sizing — keeps the strip dense without crowding controls.
const STRIP_THUMB_SIZE = 44;
const STRIP_THUMB_GAP = 4;

// ─── helpers ─────────────────────────────────────────────────────────────────

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDuration = (ms?: number): string => {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
};

const formatDate = (ts: number): string =>
  new Date(ts).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const getMimeLabel = (mimeType?: string): string => {
  if (!mimeType) return 'Unknown';
  const map: Record<string, string> = {
    'image/jpeg': 'JPEG Image',
    'image/jpg': 'JPEG Image',
    'image/png': 'PNG Image',
    'image/gif': 'GIF Image',
    'image/webp': 'WebP Image',
    'image/heic': 'HEIC Image',
    'video/mp4': 'MP4 Video',
    'video/quicktime': 'QuickTime Video',
    'video/mov': 'MOV Video',
    'audio/mpeg': 'MP3 Audio',
    'audio/mp4': 'AAC Audio',
    'audio/aac': 'AAC Audio',
    'audio/wav': 'WAV Audio',
    'audio/ogg': 'OGG Audio',
    'application/pdf': 'PDF Document',
  };
  return map[mimeType] ?? mimeType.split('/').pop()?.toUpperCase() ?? 'File';
};

const getFileExt = (meta?: MediaMetadata): string => {
  if (meta?.fileName) {
    const parts = meta.fileName.split('.');
    if (parts.length > 1) return `.${parts[parts.length - 1].toUpperCase()}`;
  }
  if (meta?.mimeType) {
    const sub = meta.mimeType.split('/')[1];
    if (sub) return `.${sub.toUpperCase()}`;
  }
  return '';
};

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// ─── media URI resolver ──────────────────────────────────────────────────────
//
// `localMediaPath` is preferred for offline/perf, but the saved path can be
// stale (file evicted, app reinstalled → Documents UUID changed). When the
// local file is missing we fall back to the remote URL so the gallery and
// full-screen viewer don't render a broken `<Image>` / dead `<VideoView>`.
//
// Returns:
//   - uri:      the URI to feed `<Image>` / `useVideoPlayer`
//   - markFailed: call from `onError` to switch to the remote URL after a
//     load failure (covers expired Firebase tokens etc.)

const useResolvedMediaUri = (message: ChatMessage | undefined) => {
  const localPath = message?.localMediaPath;
  const remoteUrl = message?.mediaUrl;
  const messageId = message?.messageId || message?.id;

  const [uri, setUri] = useState<string | undefined>(localPath ?? remoteUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setUri(localPath ?? remoteUrl);
    (async () => {
      if (localPath) {
        const exists = await mediaExistsLocally(localPath);
        if (cancelled) return;
        if (exists) {
          setUri(localPath);
          return;
        }
      }
      if (remoteUrl) {
        setUri(remoteUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId, localPath, remoteUrl]);

  const markFailed = useCallback(() => {
    setFailed((prev) => {
      if (prev) return prev;
      if (remoteUrl && uri !== remoteUrl) {
        setUri(remoteUrl);
      }
      return true;
    });
  }, [remoteUrl, uri]);

  return { uri, markFailed, failed };
};

// ─── tab config ───────────────────────────────────────────────────────────────

type TabId = 'media' | 'docs' | 'links';

const TABS: { id: TabId; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'media', label: 'Media', icon: 'images-outline' },
  { id: 'docs', label: 'Docs', icon: 'document-outline' },
  { id: 'links', label: 'Links', icon: 'link-outline' },
];

// ─── ZoomableImage (RNGH v2 + Reanimated, worklet-safe) ──────────────────────
//
// Gestures supported:
//   - Pinch (focal-point preserving) → smooth zoom anchored at finger midpoint
//   - Pan (zoomed) → drag image within bounds
//   - Pan (not zoomed) → swipe left/right to navigate, swipe down to dismiss
//   - Double-tap → zoom in to 2.5× at tap point, or zoom out
//   - Single-tap → toggle viewer chrome
//
// All math is inlined inside worklet callbacks to avoid the
// "Tried to synchronously call a non-worklet function on the UI thread" crash.

const SWIPE_DISTANCE_THRESHOLD = SCREEN_WIDTH * 0.22;
const SWIPE_VELOCITY_THRESHOLD = 700;
const DISMISS_DISTANCE_THRESHOLD = 120;
const DISMISS_VELOCITY_THRESHOLD = 900;
const SWIPE_UP_DISTANCE_THRESHOLD = 90;
const SWIPE_UP_VELOCITY_THRESHOLD = 700;
const DOUBLE_TAP_SCALE = 2.5;

// Tuned for a smooth, iOS-feeling spring across the viewer
const SPRING = { damping: 24, stiffness: 180, mass: 0.6 };
const SPRING_SNAPPY = { damping: 28, stiffness: 260, mass: 0.5 };
const TIMING_OUT = { duration: 280, easing: Easing.out(Easing.cubic) };
const TIMING_FAST = { duration: 220, easing: Easing.out(Easing.cubic) };

interface ZoomableImageProps {
  uri: string;
  onSwipeNext: () => void;
  onSwipePrev: () => void;
  onDismiss: () => void;
  onSingleTap: () => void;
  onSwipeUp: () => void;
  /** Called when the underlying `<Image>` fails to load — used to swap to the remote URL. */
  onError?: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  backdropOpacity: SharedValue<number>;
}

const ZoomableImage = React.memo(({
  uri,
  onSwipeNext,
  onSwipePrev,
  onDismiss,
  onSingleTap,
  onSwipeUp,
  onError,
  hasNext,
  hasPrev,
  backdropOpacity,
}: ZoomableImageProps) => {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const opacity = useSharedValue(1);

  // Pinch focal anchor (in centered coords)
  const pinchOriginX = useSharedValue(0);
  const pinchOriginY = useSharedValue(0);
  const pinchSavedTx = useSharedValue(0);
  const pinchSavedTy = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      'worklet';
      pinchOriginX.value = e.focalX - SCREEN_WIDTH / 2;
      pinchOriginY.value = e.focalY - SCREEN_HEIGHT / 2;
      pinchSavedTx.value = translateX.value;
      pinchSavedTy.value = translateY.value;
    })
    .onUpdate((e) => {
      'worklet';
      const newScale = Math.max(
        MIN_SCALE * 0.7,
        Math.min(MAX_SCALE, savedScale.value * e.scale),
      );
      const factor = newScale / savedScale.value;
      scale.value = newScale;
      // Keep the focal point under the fingers as the image grows
      translateX.value = pinchOriginX.value + (pinchSavedTx.value - pinchOriginX.value) * factor;
      translateY.value = pinchOriginY.value + (pinchSavedTy.value - pinchOriginY.value) * factor;
    })
    .onEnd(() => {
      'worklet';
      if (scale.value < MIN_SCALE) {
        scale.value = withSpring(MIN_SCALE, SPRING);
        translateX.value = withSpring(0, SPRING);
        translateY.value = withSpring(0, SPRING);
        savedScale.value = MIN_SCALE;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        const maxX = ((scale.value - 1) * SCREEN_WIDTH) / 2;
        const maxY = ((scale.value - 1) * SCREEN_HEIGHT) / 2;
        const clampedX = Math.max(-maxX, Math.min(maxX, translateX.value));
        const clampedY = Math.max(-maxY, Math.min(maxY, translateY.value));
        translateX.value = withSpring(clampedX, SPRING);
        translateY.value = withSpring(clampedY, SPRING);
        savedScale.value = scale.value;
        savedTranslateX.value = clampedX;
        savedTranslateY.value = clampedY;
      }
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .onUpdate((e) => {
      'worklet';
      if (scale.value > 1.05) {
        // Zoomed: pan within image, hard clamp to bounds
        const maxX = ((scale.value - 1) * SCREEN_WIDTH) / 2;
        const maxY = ((scale.value - 1) * SCREEN_HEIGHT) / 2;
        translateX.value = Math.max(
          -maxX,
          Math.min(maxX, savedTranslateX.value + e.translationX),
        );
        translateY.value = Math.max(
          -maxY,
          Math.min(maxY, savedTranslateY.value + e.translationY),
        );
      } else {
        // Not zoomed: drive image with finger for swipe-nav, swipe-dismiss, swipe-up-info
        translateX.value = e.translationX;
        if (e.translationY > 0) {
          // Pull down: full follow + dim backdrop + slight shrink (dismiss preview)
          translateY.value = e.translationY;
          const dragProgress = Math.min(1, e.translationY / 380);
          backdropOpacity.value = 1 - dragProgress * 0.85;
          scale.value = 1 - dragProgress * 0.18;
        } else {
          // Pull up: rubber-banded translation as a hint that info is reachable
          translateY.value = e.translationY * 0.4;
          backdropOpacity.value = 1;
          scale.value = 1;
        }
      }
    })
    .onEnd((e) => {
      'worklet';
      if (savedScale.value > 1.05) {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        return;
      }
      const horizDominant = Math.abs(e.translationX) > Math.abs(e.translationY);
      const verticalDismiss =
        !horizDominant &&
        (e.translationY > DISMISS_DISTANCE_THRESHOLD ||
          e.velocityY > DISMISS_VELOCITY_THRESHOLD);
      const verticalInfo =
        !horizDominant &&
        (e.translationY < -SWIPE_UP_DISTANCE_THRESHOLD ||
          e.velocityY < -SWIPE_UP_VELOCITY_THRESHOLD);
      // Swipe mapping is intentionally inverted vs. the typical iOS photo
      // viewer: drag-right advances to the next item, drag-left goes back.
      const swipeNext =
        horizDominant &&
        hasNext &&
        (e.translationX > SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX > SWIPE_VELOCITY_THRESHOLD);
      const swipePrev =
        horizDominant &&
        hasPrev &&
        (e.translationX < -SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX < -SWIPE_VELOCITY_THRESHOLD);

      if (verticalDismiss) {
        translateY.value = withTiming(SCREEN_HEIGHT, TIMING_OUT);
        opacity.value = withTiming(0, TIMING_OUT);
        backdropOpacity.value = withTiming(0, TIMING_OUT);
        runOnJS(onDismiss)();
      } else if (verticalInfo) {
        // Snap back image, then reveal info panel
        translateX.value = withSpring(0, SPRING_SNAPPY);
        translateY.value = withSpring(0, SPRING_SNAPPY);
        scale.value = withSpring(1, SPRING_SNAPPY);
        backdropOpacity.value = withSpring(1, SPRING_SNAPPY);
        runOnJS(onSwipeUp)();
      } else if (swipeNext) {
        translateX.value = withTiming(SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipeNext)();
        });
      } else if (swipePrev) {
        translateX.value = withTiming(-SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipePrev)();
        });
      } else {
        // Snap everything back to neutral together (same SPRING → arrives in sync)
        translateX.value = withSpring(0, SPRING);
        translateY.value = withSpring(0, SPRING);
        scale.value = withSpring(1, SPRING);
        backdropOpacity.value = withSpring(1, SPRING);
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(280)
    .onEnd((e) => {
      'worklet';
      if (scale.value > 1.05) {
        scale.value = withSpring(1, SPRING);
        translateX.value = withSpring(0, SPRING);
        translateY.value = withSpring(0, SPRING);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        const cTapX = e.x - SCREEN_WIDTH / 2;
        const cTapY = e.y - SCREEN_HEIGHT / 2;
        const newTx = -cTapX * DOUBLE_TAP_SCALE;
        const newTy = -cTapY * DOUBLE_TAP_SCALE;
        const maxX = ((DOUBLE_TAP_SCALE - 1) * SCREEN_WIDTH) / 2;
        const maxY = ((DOUBLE_TAP_SCALE - 1) * SCREEN_HEIGHT) / 2;
        const clampedX = Math.max(-maxX, Math.min(maxX, newTx));
        const clampedY = Math.max(-maxY, Math.min(maxY, newTy));
        scale.value = withSpring(DOUBLE_TAP_SCALE, SPRING);
        translateX.value = withSpring(clampedX, SPRING);
        translateY.value = withSpring(clampedY, SPRING);
        savedScale.value = DOUBLE_TAP_SCALE;
        savedTranslateX.value = clampedX;
        savedTranslateY.value = clampedY;
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(250)
    .onEnd(() => {
      'worklet';
      runOnJS(onSingleTap)();
    });

  const composed = Gesture.Simultaneous(
    Gesture.Race(Gesture.Exclusive(doubleTap, singleTap), pan),
    pinch,
  );

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Reanimated.View style={[styles.zoomableContainer, animStyle]}>
        <Image
          source={{ uri }}
          style={styles.zoomableImage}
          resizeMode="contain"
          onError={onError}
          // Drop the default 300ms cross-fade so cached images appear instantly
          // instead of flashing black when the viewer mounts or the user swipes.
          fadeDuration={0}
          progressiveRenderingEnabled
        />
      </Reanimated.View>
    </GestureDetector>
  );
});
ZoomableImage.displayName = 'ZoomableImage';

// ─── FullScreenVideoPlayer ────────────────────────────────────────────────────

interface FullScreenVideoPlayerProps {
  uri: string;
  /** Fired when the player reports a fatal error (e.g. stale file path, unreachable URL). */
  onError?: () => void;
}

const FullScreenVideoPlayer = ({ uri, onError }: FullScreenVideoPlayerProps) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  // expo-video surfaces playback errors via the `statusChange` event. When the
  // player's status flips to `error` we let the caller know so it can swap the
  // URI (e.g. fall back from a stale local path to the remote URL).
  useEffect(() => {
    if (!onError) return;
    const sub = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error' || error) {
        onError();
      }
    });
    return () => {
      sub.remove();
    };
  }, [player, onError]);

  return (
    <VideoView
      player={player}
      style={styles.videoPlayer}
      contentFit="contain"
      nativeControls
    />
  );
};

// ─── VideoSwipeContainer ─────────────────────────────────────────────────────
//
// Wraps the video player with full swipe support: vertical (dismiss / info)
// and horizontal (prev / next navigation). Uses `activeOffsetY` + `failOffsetX`
// so the native video scrubber keeps working — the swipe gesture only takes
// over once the user commits to a clear directional drag.

interface VideoSwipeContainerProps {
  uri: string;
  onDismiss: () => void;
  onSwipeUp: () => void;
  onSwipeNext: () => void;
  onSwipePrev: () => void;
  onSingleTap: () => void;
  /** Forwarded to the underlying expo-video player. Fires on playback failure. */
  onError?: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  backdropOpacity: SharedValue<number>;
}

const VideoSwipeContainer = React.memo(({
  uri,
  onDismiss,
  onSwipeUp,
  onSwipeNext,
  onSwipePrev,
  onError,
  hasNext,
  hasPrev,
  backdropOpacity,
}: VideoSwipeContainerProps) => {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(1);
  const scaleVal = useSharedValue(1);

  const pan = Gesture.Pan()
    .activeOffsetY([-18, 18])
    .activeOffsetX([-18, 18])
    .onUpdate((e) => {
      'worklet';
      const isHoriz = Math.abs(e.translationX) > Math.abs(e.translationY);
      if (isHoriz) {
        translateX.value = e.translationX;
        translateY.value = 0;
        scaleVal.value = 1;
        backdropOpacity.value = 1;
      } else if (e.translationY > 0) {
        translateX.value = 0;
        translateY.value = e.translationY;
        const dragProgress = Math.min(1, e.translationY / 380);
        backdropOpacity.value = 1 - dragProgress * 0.85;
        scaleVal.value = 1 - dragProgress * 0.15;
      } else {
        translateX.value = 0;
        translateY.value = e.translationY * 0.4;
        backdropOpacity.value = 1;
        scaleVal.value = 1;
      }
    })
    .onEnd((e) => {
      'worklet';
      const horizDominant = Math.abs(e.translationX) > Math.abs(e.translationY);
      const dismiss =
        !horizDominant &&
        (e.translationY > DISMISS_DISTANCE_THRESHOLD ||
          e.velocityY > DISMISS_VELOCITY_THRESHOLD);
      const swipeUp =
        !horizDominant &&
        (e.translationY < -SWIPE_UP_DISTANCE_THRESHOLD ||
          e.velocityY < -SWIPE_UP_VELOCITY_THRESHOLD);
      // Match ZoomableImage: drag-right → next, drag-left → previous.
      const swipeNext =
        horizDominant &&
        hasNext &&
        (e.translationX > SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX > SWIPE_VELOCITY_THRESHOLD);
      const swipePrev =
        horizDominant &&
        hasPrev &&
        (e.translationX < -SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX < -SWIPE_VELOCITY_THRESHOLD);

      if (dismiss) {
        translateY.value = withTiming(SCREEN_HEIGHT, TIMING_OUT);
        opacity.value = withTiming(0, TIMING_OUT);
        backdropOpacity.value = withTiming(0, TIMING_OUT);
        runOnJS(onDismiss)();
      } else if (swipeUp) {
        translateX.value = withSpring(0, SPRING_SNAPPY);
        translateY.value = withSpring(0, SPRING_SNAPPY);
        scaleVal.value = withSpring(1, SPRING_SNAPPY);
        backdropOpacity.value = withSpring(1, SPRING_SNAPPY);
        runOnJS(onSwipeUp)();
      } else if (swipeNext) {
        translateX.value = withTiming(SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipeNext)();
        });
      } else if (swipePrev) {
        translateX.value = withTiming(-SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipePrev)();
        });
      } else {
        translateX.value = withSpring(0, SPRING);
        translateY.value = withSpring(0, SPRING);
        scaleVal.value = withSpring(1, SPRING);
        backdropOpacity.value = withSpring(1, SPRING);
      }
    });

  // Pan-only on video — any tap gesture here would race the native player's
  // play/pause/scrub touch handling and make controls feel laggy. The user can
  // close via the always-visible top bar; swipe-up still opens info.
  const composed = pan;

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scaleVal.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Reanimated.View style={[styles.zoomableContainer, animStyle]}>
        <FullScreenVideoPlayer uri={uri} onError={onError} />
      </Reanimated.View>
    </GestureDetector>
  );
});
VideoSwipeContainer.displayName = 'VideoSwipeContainer';

// ─── MediaInfoPanel ───────────────────────────────────────────────────────────

interface InfoRow {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
}

interface MediaInfoPanelProps {
  message: ChatMessage;
  senderName: string;
  visible: boolean;
  onClose: () => void;
}

const MediaInfoPanel = ({ message, senderName, visible, onClose }: MediaInfoPanelProps) => {
  const { theme, isDark } = useTheme();
  const slideAnim = useRef(new Animated.Value(500)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: visible ? 0 : 500,
      useNativeDriver: true,
      damping: 28,
      stiffness: 220,
      mass: 0.8,
    }).start();
  }, [visible, slideAnim]);

  const meta = message.mediaMetadata;

  const rows: InfoRow[] = [];

  rows.push({
    label: 'Type',
    icon:
      message.type === 'image'
        ? 'image-outline'
        : message.type === 'video'
        ? 'videocam-outline'
        : message.type === 'audio'
        ? 'musical-notes-outline'
        : 'document-outline',
    value: getMimeLabel(meta?.mimeType),
  });

  const ext = getFileExt(meta);
  if (ext) rows.push({ label: 'Extension', icon: 'code-slash-outline', value: ext });

  if (meta?.width && meta?.height) {
    rows.push({
      label: 'Resolution',
      icon: 'resize-outline',
      value: `${meta.width} × ${meta.height} px`,
    });
  }

  if (meta?.duration) {
    rows.push({ label: 'Duration', icon: 'time-outline', value: formatDuration(meta.duration) });
  }

  if (meta?.fileSize) {
    rows.push({ label: 'File size', icon: 'server-outline', value: formatFileSize(meta.fileSize) });
  }

  if (meta?.fileName) {
    rows.push({ label: 'File name', icon: 'document-text-outline', value: meta.fileName });
  }

  rows.push({ label: 'Sent', icon: 'calendar-outline', value: formatDate(message.createdAt) });
  rows.push({ label: 'From', icon: 'person-outline', value: senderName });

  return (
    <Animated.View
      style={[
        styles.infoPanel,
        {
          backgroundColor: isDark ? 'rgba(20,20,28,0.97)' : 'rgba(255,255,255,0.97)',
          transform: [{ translateY: slideAnim }],
        },
      ]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <View style={styles.infoPanelHandle} />
      <View style={styles.infoPanelHeader}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
          File Info
        </Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Ionicons name="close" size={22} color={theme.colors.onSurface} />
        </TouchableOpacity>
      </View>
      <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
        {rows.map((row, i) => (
          <View
            key={row.label}
            style={[
              styles.infoRow,
              i < rows.length - 1 && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: isDark
                  ? 'rgba(255,255,255,0.08)'
                  : 'rgba(0,0,0,0.08)',
              },
            ]}
          >
            <View style={[styles.infoIconWrap, { backgroundColor: theme.colors.primaryContainer }]}>
              <Ionicons name={row.icon} size={16} color={theme.colors.primary} />
            </View>
            <View style={styles.infoRowContent}>
              <Text style={[styles.infoLabel, { color: theme.colors.onSurfaceVariant }]}>
                {row.label}
              </Text>
              <Text
                style={[styles.infoValue, { color: theme.colors.onSurface }]}
                numberOfLines={2}
              >
                {row.value}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  );
};

// ─── FullScreenViewer ─────────────────────────────────────────────────────────

interface FullScreenViewerProps {
  messages: ChatMessage[];
  initialIndex: number;
  senderMap: Map<string, string>;
  visible: boolean;
  onClose: () => void;
}

const FullScreenViewer = ({
  messages,
  initialIndex,
  senderMap,
  visible,
  onClose,
}: FullScreenViewerProps) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showInfo, setShowInfo] = useState(false);
  const [showChrome, setShowChrome] = useState(true);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const backdropOpacity = useSharedValue(1);

  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      setShowInfo(false);
      setShowChrome(true);
      fadeAnim.setValue(1);
      backdropOpacity.value = 1;
    }
  }, [initialIndex, visible, fadeAnim, backdropOpacity]);

  const toggleChrome = useCallback(() => {
    setShowChrome((prev) => {
      const next = !prev;
      Animated.timing(fadeAnim, {
        toValue: next ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      return next;
    });
  }, [fadeAnim]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(messages.length - 1, i + 1));
    setShowInfo(false);
  }, [messages.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
    setShowInfo(false);
  }, []);

  // Thumbnail strip — keep the active thumb centred when the user navigates.
  const stripRef = useRef<FlatList<ChatMessage>>(null);
  useEffect(() => {
    if (!visible) return;
    stripRef.current?.scrollToIndex({
      index: currentIndex,
      viewPosition: 0.5,
      animated: true,
    });
  }, [currentIndex, visible]);

  const handleThumbPress = useCallback((idx: number) => {
    setCurrentIndex(idx);
    setShowInfo(false);
  }, []);

  const handleDismiss = useCallback(() => {
    // Allow the dismiss animation to play before closing the modal
    setTimeout(onClose, 230);
  }, [onClose]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  // Resolve the URI for the currently-visible item with local→remote fallback.
  // Hook must run unconditionally on every render (no early-returning above it).
  const currentMessage = messages[currentIndex];
  const { uri: mediaUri, markFailed } = useResolvedMediaUri(currentMessage);

  // Adjacent items — used to prefetch their media so the next/prev swipe
  // resolves to a cached image instantly instead of flashing black for 1–3s
  // while a fresh load runs. Only image items share a cache with `<Image>`;
  // videos use a separate decoder pipeline so we leave them alone here.
  const prevMessage = currentIndex > 0 ? messages[currentIndex - 1] : undefined;
  const nextMessage =
    currentIndex < messages.length - 1 ? messages[currentIndex + 1] : undefined;
  const prevPreloadUri =
    prevMessage?.type === 'image'
      ? (prevMessage.localMediaPath ?? prevMessage.mediaUrl)
      : undefined;
  const nextPreloadUri =
    nextMessage?.type === 'image'
      ? (nextMessage.localMediaPath ?? nextMessage.mediaUrl)
      : undefined;

  // Kick the platform image cache for any adjacent remote URLs. `Image.prefetch`
  // ignores `file://` paths (and rejects), so we swallow errors — the hidden
  // `<Image>` preloaders below cover the local-file case.
  useEffect(() => {
    [prevPreloadUri, nextPreloadUri].forEach((u) => {
      if (u && /^https?:\/\//i.test(u)) {
        Image.prefetch(u).catch(() => undefined);
      }
    });
  }, [prevPreloadUri, nextPreloadUri]);

  if (!visible || messages.length === 0) return null;
  if (!currentMessage) return null;

  const msg = currentMessage;
  const senderName = senderMap.get(msg.senderId) ?? 'Unknown';
  const isVideo = msg.type === 'video';
  const itemKey = msg.messageId || msg.id;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.viewerRoot}>
        {/* Animated black backdrop — fades during drag-to-dismiss */}
        <Reanimated.View
          style={[StyleSheet.absoluteFill, styles.viewerBackdrop, backdropStyle]}
          pointerEvents="none"
        />

        {/* Hidden preloaders — keep adjacent images decoded in the RN image
            cache so the swipe-to-next animation lands on a fully rendered
            frame, not a 1–3s black gap. Render size must match the visible
            image size for the RN cache hit to bypass decoding. */}
        {prevPreloadUri ? (
          <View style={styles.preloadImage} pointerEvents="none">
            <Image
              source={{ uri: prevPreloadUri }}
              style={StyleSheet.absoluteFill}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              fadeDuration={0}
            />
          </View>
        ) : null}
        {nextPreloadUri ? (
          <View style={styles.preloadImage} pointerEvents="none">
            <Image
              source={{ uri: nextPreloadUri }}
              style={StyleSheet.absoluteFill}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              fadeDuration={0}
            />
          </View>
        ) : null}

        {/* Media area */}
        <View style={styles.viewerMedia}>
          {mediaUri ? (
            isVideo ? (
              <VideoSwipeContainer
                // Re-mount only on item change, not on a same-item URI fallback
                // (local→remote). Without this, the async hook flips would
                // unmount the player mid-load and cause a second black flash.
                key={itemKey}
                uri={mediaUri}
                onSwipeNext={goNext}
                onSwipePrev={goPrev}
                onDismiss={handleDismiss}
                onSingleTap={toggleChrome}
                onSwipeUp={() => setShowInfo(true)}
                onError={markFailed}
                hasNext={currentIndex < messages.length - 1}
                hasPrev={currentIndex > 0}
                backdropOpacity={backdropOpacity}
              />
            ) : (
              <ZoomableImage
                key={itemKey}
                uri={mediaUri}
                onSwipeNext={goNext}
                onSwipePrev={goPrev}
                onDismiss={handleDismiss}
                onSingleTap={toggleChrome}
                onSwipeUp={() => setShowInfo(true)}
                onError={markFailed}
                hasNext={currentIndex < messages.length - 1}
                hasPrev={currentIndex > 0}
                backdropOpacity={backdropOpacity}
              />
            )
          ) : (
            <View style={styles.viewerPlaceholder}>
              <Ionicons name="cloud-offline-outline" size={48} color="#666" />
              <Text style={{ color: '#666', marginTop: 8 }}>Media unavailable</Text>
            </View>
          )}
        </View>

        {/* Top bar */}
        <Animated.View
          style={[styles.viewerTopBar, { paddingTop: insets.top + 8, opacity: fadeAnim }]}
          pointerEvents={showChrome ? 'auto' : 'none'}
        >
          <TouchableOpacity onPress={onClose} style={styles.viewerNavButton} hitSlop={12}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            onPress={() => setShowInfo((v) => !v)}
            style={styles.viewerNavButton}
            hitSlop={12}
          >
            <Ionicons
              name={showInfo ? 'information-circle' : 'information-circle-outline'}
              size={26}
              color={showInfo ? theme.colors.primary : '#fff'}
            />
          </TouchableOpacity>
        </Animated.View>

        {/* Bottom bar */}
        <Animated.View
          style={[styles.viewerBottomBar, { paddingBottom: insets.bottom + 8, opacity: fadeAnim }]}
          pointerEvents={showChrome ? 'box-none' : 'none'}
        >
          {messages.length > 1 && (
            <FlatList
              ref={stripRef}
              data={messages}
              keyExtractor={(item) => item.messageId || item.id}
              horizontal
              // `inverted` reverses item order so index 0 sits on the right and
              // higher indices flow leftward. This matches the swipe mapping
              // (drag-right → next): the upcoming item is visually to the left
              // of the active thumb, mirroring how the next image enters.
              inverted
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbStripContent}
              getItemLayout={(_, idx) => ({
                length: STRIP_THUMB_SIZE + STRIP_THUMB_GAP,
                offset: (STRIP_THUMB_SIZE + STRIP_THUMB_GAP) * idx,
                index: idx,
              })}
              onScrollToIndexFailed={({ index }) => {
                stripRef.current?.scrollToOffset({
                  offset: index * (STRIP_THUMB_SIZE + STRIP_THUMB_GAP),
                  animated: false,
                });
              }}
              renderItem={({ item, index }) => (
                <StripThumb
                  message={item}
                  active={index === currentIndex}
                  onPress={() => handleThumbPress(index)}
                />
              )}
            />
          )}
          <Text style={styles.viewerCounter}>
            {currentIndex + 1} / {messages.length}
          </Text>
          <Text style={styles.viewerSender}>{senderName}</Text>
          <Text style={styles.viewerDate}>{formatDate(msg.createdAt)}</Text>
        </Animated.View>

        {/* Prev / next arrows (visual hint for non-touch users; swipe also works) */}
        {currentIndex > 0 && showChrome && (
          <TouchableOpacity
            style={[styles.viewerArrow, styles.viewerArrowLeft]}
            onPress={goPrev}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={30} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
        )}
        {currentIndex < messages.length - 1 && showChrome && (
          <TouchableOpacity
            style={[styles.viewerArrow, styles.viewerArrowRight]}
            onPress={goNext}
            hitSlop={8}
          >
            <Ionicons name="chevron-forward" size={30} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
        )}

        {/* Info panel slides up from bottom */}
        <MediaInfoPanel
          message={msg}
          senderName={senderName}
          visible={showInfo}
          onClose={() => setShowInfo(false)}
        />
      </View>
    </Modal>
  );
};

// ─── MediaCell ────────────────────────────────────────────────────────────────

interface MediaCellProps {
  message: ChatMessage;
  onPress: () => void;
  onLongPress?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
}

const MediaCell = React.memo(({ message, onPress, onLongPress, selectionMode, selected }: MediaCellProps) => {
  const { theme } = useTheme();
  const { uri, markFailed } = useResolvedMediaUri(message);
  const isVideo = message.type === 'video';
  const videoThumb = useVideoThumbnail(isVideo ? uri : undefined);
  const displayUri = isVideo ? videoThumb : uri;
  const duration = message.mediaMetadata?.duration;

  return (
    <TouchableOpacity
      style={[
        styles.cell,
        { width: CELL_SIZE, height: CELL_SIZE },
        selected && { borderWidth: 3, borderColor: theme.colors.primary },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.82}
    >
      {displayUri ? (
        <Image
          source={{ uri: displayUri }}
          style={styles.cellImage}
          resizeMode="cover"
          onError={markFailed}
          fadeDuration={0}
          progressiveRenderingEnabled
        />
      ) : (
        <View style={[styles.cellPlaceholder, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Ionicons
            name={isVideo ? 'videocam-outline' : 'image-outline'}
            size={28}
            color={theme.colors.onSurfaceVariant}
          />
        </View>
      )}
      {isVideo && !selectionMode && (
        <View style={styles.cellVideoOverlay}>
          <Ionicons name="play" size={12} color="#fff" />
          {duration ? (
            <Text style={styles.cellDuration}>{formatDuration(duration)}</Text>
          ) : null}
        </View>
      )}
      {selectionMode && (
        <View
          style={[
            styles.cellSelectCheckbox,
            {
              backgroundColor: selected ? theme.colors.primary : 'rgba(0,0,0,0.4)',
              borderColor: selected ? theme.colors.primary : 'rgba(255,255,255,0.85)',
            },
          ]}
        >
          {selected && <Ionicons name="checkmark" size={14} color="#fff" />}
        </View>
      )}
    </TouchableOpacity>
  );
});

// ─── StripThumb (bottom carousel item) ───────────────────────────────────────

interface StripThumbProps {
  message: ChatMessage;
  active: boolean;
  onPress: () => void;
}

const StripThumb = React.memo(({ message, active, onPress }: StripThumbProps) => {
  const { theme } = useTheme();
  const { uri, markFailed } = useResolvedMediaUri(message);
  const isVideo = message.type === 'video';
  const videoThumb = useVideoThumbnail(isVideo ? uri : undefined);
  const displayUri = isVideo ? videoThumb : uri;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[
        styles.stripThumb,
        {
          borderColor: active ? theme.colors.primary : 'rgba(255,255,255,0.18)',
          borderWidth: active ? 2 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      {displayUri ? (
        <Image
          source={{ uri: displayUri }}
          style={styles.stripThumbImage}
          resizeMode="cover"
          onError={markFailed}
          fadeDuration={0}
          progressiveRenderingEnabled
        />
      ) : (
        <View style={styles.stripThumbFallback}>
          <Ionicons
            name={isVideo ? 'videocam-outline' : 'image-outline'}
            size={16}
            color="#aaa"
          />
        </View>
      )}
      {isVideo && (
        <View style={styles.stripThumbVideoBadge}>
          <Ionicons name="play" size={10} color="#fff" />
        </View>
      )}
    </TouchableOpacity>
  );
});
StripThumb.displayName = 'StripThumb';

// ─── DocRow ───────────────────────────────────────────────────────────────────

interface DocRowProps {
  message: ChatMessage;
  senderName: string;
  onPress?: () => void;
  onLongPress?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
}

const DocRow = React.memo(({ message, senderName, onPress, onLongPress, selectionMode, selected }: DocRowProps) => {
  const { theme, isDark } = useTheme();
  const meta = message.mediaMetadata;
  const ext = getFileExt(meta);
  const mimeLabel = getMimeLabel(meta?.mimeType);
  const isAudio = message.type === 'audio';

  return (
    <TouchableOpacity
      style={[
        styles.docRow,
        {
          borderBottomColor: isDark
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(0,0,0,0.06)',
        },
        selected && { backgroundColor: isDark ? 'rgba(53,198,255,0.15)' : 'rgba(31,111,235,0.10)' },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      {selectionMode ? (
        <View
          style={[
            styles.rowSelectCheckbox,
            {
              backgroundColor: selected ? theme.colors.primary : 'transparent',
              borderColor: selected ? theme.colors.primary : (isDark ? '#666' : '#bbb'),
            },
          ]}
        >
          {selected && <Ionicons name="checkmark" size={12} color="#fff" />}
        </View>
      ) : null}
      <View
        style={[
          styles.docIconWrap,
          {
            backgroundColor: isAudio
              ? theme.colors.secondaryContainer
              : theme.colors.primaryContainer,
          },
        ]}
      >
        <Ionicons
          name={isAudio ? 'musical-notes-outline' : 'document-text-outline'}
          size={24}
          color={isAudio ? theme.colors.secondary : theme.colors.primary}
        />
      </View>
      <View style={styles.docInfo}>
        <Text numberOfLines={1} style={[styles.docName, { color: theme.colors.onSurface }]}>
          {meta?.fileName ?? (isAudio ? 'Voice message' : 'Document')}
        </Text>
        <Text style={[styles.docMeta, { color: theme.colors.onSurfaceVariant }]}>
          {[mimeLabel, ext, formatFileSize(meta?.fileSize), senderName]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {!selectionMode && (
        <Ionicons name="chevron-forward" size={16} color={theme.colors.onSurfaceVariant} />
      )}
    </TouchableOpacity>
  );
});

// ─── LinkRow ──────────────────────────────────────────────────────────────────

interface LinkRowProps {
  message: ChatMessage;
  senderName: string;
  onPress?: () => void;
  onLongPress?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
}

const LinkRow = React.memo(({ message, senderName, onPress, onLongPress, selectionMode, selected }: LinkRowProps) => {
  const { theme, isDark } = useTheme();
  const matches = message.content.match(URL_REGEX) ?? [];

  return (
    <>
      {matches.map((url, i) => (
        <TouchableOpacity
          key={`${message.messageId}_${i}`}
          onPress={onPress}
          onLongPress={onLongPress}
          activeOpacity={selectionMode ? 0.7 : 1}
          style={[
            styles.docRow,
            {
              borderBottomColor: isDark
                ? 'rgba(255,255,255,0.06)'
                : 'rgba(0,0,0,0.06)',
            },
            selected && { backgroundColor: isDark ? 'rgba(53,198,255,0.15)' : 'rgba(31,111,235,0.10)' },
          ]}
        >
          {selectionMode ? (
            <View
              style={[
                styles.rowSelectCheckbox,
                {
                  backgroundColor: selected ? theme.colors.primary : 'transparent',
                  borderColor: selected ? theme.colors.primary : (isDark ? '#666' : '#bbb'),
                },
              ]}
            >
              {selected && <Ionicons name="checkmark" size={12} color="#fff" />}
            </View>
          ) : null}
          <View style={[styles.docIconWrap, { backgroundColor: theme.colors.secondaryContainer }]}>
            <Ionicons name="link-outline" size={22} color={theme.colors.secondary} />
          </View>
          <View style={styles.docInfo}>
            <Text numberOfLines={2} style={[styles.docName, { color: theme.colors.primary }]}>
              {url}
            </Text>
            <Text style={[styles.docMeta, { color: theme.colors.onSurfaceVariant }]}>
              {formatDate(message.createdAt)} · {senderName}
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </>
  );
});

// ─── EmptyState ───────────────────────────────────────────────────────────────

const EmptyState = ({
  icon,
  label,
  topPad,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  topPad: number;
}) => {
  const { theme } = useTheme();
  return (
    <View style={[styles.empty, { marginTop: topPad }]}>
      <Ionicons name={icon} size={56} color={theme.colors.onSurfaceVariant} />
      <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>{label}</Text>
    </View>
  );
};

// ─── ChatMediaGalleryScreen ───────────────────────────────────────────────────

interface ChatMediaGalleryParams {
  chatId: string;
  title?: string;
  backTitle?: string;
  participants?: ChatParticipant[];
  /** When set, the viewer opens automatically on that media item (e.g. tapped from a chat bubble). */
  initialMessageId?: string;
}

export const ChatMediaGalleryScreen = () => {
  const navigation = useNavigation<any>();
  const route = useRoute();
  const params = route.params as ChatMediaGalleryParams;
  const { subscribeToMessages, deleteMessageForEveryone } = useChat();
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('media');
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const autoOpenedRef = useRef(false);

  // Multi-select state — used for bulk delete-for-me / delete-for-everyone in
  // each tab. Switching tabs resets the selection so the toolbar's actions
  // never apply across tab boundaries.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [undoSnapshot, setUndoSnapshot] = useState<{ messageIds: string[] } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Delete-for-everyone window — keep parity with ChatRoomScreen (24h).
  const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000;
  const DELETE_UNDO_WINDOW_MS = 5_000;

  // Animated tab indicator
  const tabIndicatorX = useRef(new Animated.Value(0)).current;
  const tabWidth = SCREEN_WIDTH / TABS.length;


  useEffect(() => {
    if (!params.chatId) return;
    const unsubscribe = subscribeToMessages(params.chatId, (items) => {
      setMessages(items);
    });
    return unsubscribe;
  }, [params.chatId, subscribeToMessages]);

  // Derived lists — exclude messages the user has hidden via "Delete for me"
  // *or* that were deleted for everyone (no point listing a tombstone in
  // Media / Docs / Links — the chat itself still shows the tombstone bubble).
  const visibleMessages = useMemo(
    () =>
      messages.filter((m) => {
        if (m.deletedForEveryone) return false;
        if (user && m.deletedFor?.includes(user.userId)) return false;
        return true;
      }),
    [messages, user],
  );

  const mediaMessages = useMemo(
    () =>
      visibleMessages.filter(
        (m) =>
          (m.type === 'image' || m.type === 'video') &&
          (m.localMediaPath || m.mediaUrl),
      ),
    [visibleMessages],
  );

  const docMessages = useMemo(
    () => visibleMessages.filter((m) => m.type === 'file' || m.type === 'audio'),
    [visibleMessages],
  );

  const linkMessages = useMemo(
    () => visibleMessages.filter((m) => m.type === 'text' && URL_REGEX.test(m.content)),
    [visibleMessages],
  );

  // Build sender name map from passed participants
  const senderMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of params.participants ?? []) {
      map.set(p.userId, p.userId === user?.userId ? 'You' : p.displayName);
    }
    return map;
  }, [params.participants, user?.userId]);

  const TAB_INDEX: Record<TabId, number> = { media: 0, docs: 1, links: 2 };

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // Native nav header — title + a contextual right button. Renders the Select
  // toggle in the actual header (not the inline tab strip) so touches don't
  // get intercepted by the transparent React Navigation header overlay.
  useLayoutEffect(() => {
    const headerRight = () =>
      selectionMode ? (
        <TouchableOpacity
          onPress={exitSelectionMode}
          hitSlop={10}
          style={{ paddingHorizontal: 12, paddingVertical: 6 }}
          accessibilityRole="button"
          accessibilityLabel="Cancel selection"
        >
          <Text style={{ color: theme.colors.primary, fontSize: 16, fontWeight: '600' }}>Cancel</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={() => {
            setSelectionMode(true);
            setSelectedIds(new Set());
          }}
          hitSlop={10}
          style={{ paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Select items"
        >
          <Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.primary} />
          <Text style={{ color: theme.colors.primary, fontSize: 15, fontWeight: '600' }}>Select</Text>
        </TouchableOpacity>
      );

    const headerTitle =
      selectionMode && selectedIds.size > 0
        ? `${selectedIds.size} selected`
        : params.title ?? 'Media';

    navigation.setOptions({
      title: headerTitle,
      headerTransparent: true,
      headerRight,
    });
  }, [navigation, params.title, selectionMode, selectedIds.size, theme.colors.primary, exitSelectionMode]);

  const handleTabPress = useCallback(
    (tab: TabId) => {
      // Switching tabs always resets selection — bulk actions are tab-scoped.
      if (selectionMode) exitSelectionMode();
      setActiveTab(tab);
      Animated.spring(tabIndicatorX, {
        toValue: TAB_INDEX[tab] * tabWidth,
        useNativeDriver: true,
        damping: 20,
        stiffness: 200,
      }).start();
    },
    [tabIndicatorX, tabWidth, selectionMode, exitSelectionMode],
  );

  const toggleSelected = useCallback((messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const enterSelectionWith = useCallback((messageId: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([messageId]));
  }, []);

  // The set of messages eligible for the current tab's selection — used by the
  // toolbar to compute `canDeleteForEveryone` and to drive bulk action dispatch.
  const selectedMessages = useMemo(() => {
    if (!selectionMode || selectedIds.size === 0) return [] as ChatMessage[];
    return messages.filter((m) => selectedIds.has(m.messageId) || selectedIds.has(m.id));
  }, [messages, selectedIds, selectionMode]);

  const canDeleteForEveryone = useMemo(() => {
    if (!user || selectedMessages.length === 0) return false;
    return selectedMessages.every(
      (m) =>
        m.senderId === user.userId &&
        Date.now() - m.createdAt < DELETE_FOR_EVERYONE_WINDOW_MS &&
        !m.deletedForEveryone,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessages, user]);

  // Schedule the undo snackbar dismiss timer.
  useEffect(() => {
    if (!undoSnapshot) {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
      return;
    }
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      setUndoSnapshot(null);
    }, DELETE_UNDO_WINDOW_MS);
    return () => {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, [undoSnapshot, DELETE_UNDO_WINDOW_MS]);

  const handleBulkDeleteForMe = useCallback(async () => {
    if (!user || selectedMessages.length === 0) return;
    const ids = selectedMessages.map((m) => m.messageId || m.id);
    warningHaptic();
    for (const id of ids) {
      await markMessageDeletedForUser(params.chatId, id, user.userId);
    }
    exitSelectionMode();
    setUndoSnapshot({ messageIds: ids });
  }, [selectedMessages, user, params.chatId, exitSelectionMode]);

  const handleBulkDeleteForEveryone = useCallback(async () => {
    if (!user || selectedMessages.length === 0) return;
    const ids = selectedMessages.map((m) => m.messageId || m.id);
    warningHaptic();
    for (const id of ids) {
      await deleteMessageForEveryone(params.chatId, id);
    }
    exitSelectionMode();
  }, [selectedMessages, user, params.chatId, deleteMessageForEveryone, exitSelectionMode]);

  const handleUndoBulkDelete = useCallback(async () => {
    if (!undoSnapshot || !user) return;
    const ids = undoSnapshot.messageIds;
    setUndoSnapshot(null);
    for (const id of ids) {
      await unmarkMessageDeletedForUser(params.chatId, id, user.userId);
    }
  }, [undoSnapshot, user, params.chatId]);

  const promptBulkDeleteForMe = useCallback(() => {
    if (selectedMessages.length === 0) return;
    Alert.alert(
      `Delete ${selectedMessages.length} item${selectedMessages.length === 1 ? '' : 's'} for me`,
      'These items will be removed from your chat. Other people will still see them.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete for me', style: 'destructive', onPress: () => { void handleBulkDeleteForMe(); } },
      ],
    );
  }, [selectedMessages, handleBulkDeleteForMe]);

  const promptBulkDeleteForEveryone = useCallback(() => {
    if (selectedMessages.length === 0) return;
    Alert.alert(
      `Delete ${selectedMessages.length} item${selectedMessages.length === 1 ? '' : 's'} for everyone`,
      'These items will be removed for everyone in this chat. They may have already seen them.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete for everyone', style: 'destructive', onPress: () => { void handleBulkDeleteForEveryone(); } },
      ],
    );
  }, [selectedMessages, handleBulkDeleteForEveryone]);

  const openViewer = useCallback((index: number) => {
    setViewerIndex(index);
    setViewerVisible(true);
  }, []);

  // Deep-link: if opened from a chat image tap, jump straight to the viewer
  // on the matching media item once messages are loaded. Only runs once per mount.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!params.initialMessageId) return;
    if (mediaMessages.length === 0) return;
    const idx = mediaMessages.findIndex(
      (m) => (m.messageId || m.id) === params.initialMessageId,
    );
    if (idx >= 0) {
      autoOpenedRef.current = true;
      setActiveTab('media');
      openViewer(idx);
    }
  }, [params.initialMessageId, mediaMessages, openViewer]);

  // Chrome heights for content padding
  const TAB_BAR_HEIGHT = insets.top + 52 + 44; // header + tabs

  // ── swipe-to-select (media grid) ────────────────────────────────────────────
  // While in selection mode, dragging a finger across thumbnails toggles each
  // cell the finger crosses (Photos.app parity). Vertical/diagonal flicks
  // beyond the threshold steal the gesture from the FlatList scroll so the
  // drag selects rather than scrolls — quick taps still toggle individual
  // cells, and out of selection mode the FlatList behaves normally.
  const gridScrollYRef = useRef(0);
  const swipeVisitedRef = useRef<Set<string>>(new Set());
  const swipeAddRef = useRef<boolean>(true);

  const indexAtGridPoint = useCallback(
    (pageX: number, pageY: number): number => {
      const yInList = pageY - TAB_BAR_HEIGHT + gridScrollYRef.current - GRID_GAP;
      const xInList = pageX - GRID_GAP;
      const stride = CELL_SIZE + GRID_GAP;
      const col = Math.floor(xInList / stride);
      const row = Math.floor(yInList / stride);
      if (col < 0 || col >= COLUMN_COUNT || row < 0) return -1;
      const cellLocalX = xInList - col * stride;
      const cellLocalY = yInList - row * stride;
      if (
        cellLocalX < 0 ||
        cellLocalX > CELL_SIZE ||
        cellLocalY < 0 ||
        cellLocalY > CELL_SIZE
      ) {
        return -1;
      }
      const idx = row * COLUMN_COUNT + col;
      if (idx >= mediaMessages.length) return -1;
      return idx;
    },
    [mediaMessages.length, TAB_BAR_HEIGHT],
  );

  const swipeVisit = useCallback(
    (pageX: number, pageY: number) => {
      const idx = indexAtGridPoint(pageX, pageY);
      if (idx < 0) return;
      const item = mediaMessages[idx];
      const id = item.messageId || item.id;
      if (swipeVisitedRef.current.has(id)) return;
      swipeVisitedRef.current.add(id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (swipeAddRef.current) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [indexAtGridPoint, mediaMessages],
  );

  const gridPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_, gs) =>
          selectionMode && (Math.abs(gs.dx) > 6 || Math.abs(gs.dy) > 6),
        onMoveShouldSetPanResponderCapture: (_, gs) =>
          selectionMode && (Math.abs(gs.dx) > 6 || Math.abs(gs.dy) > 6),
        onPanResponderGrant: (e) => {
          swipeVisitedRef.current = new Set();
          // Decide add vs remove based on the cell under the start point —
          // if it's already selected, this drag deselects; otherwise selects.
          const startIdx = indexAtGridPoint(e.nativeEvent.pageX, e.nativeEvent.pageY);
          if (startIdx >= 0) {
            const startItem = mediaMessages[startIdx];
            const startId = startItem.messageId || startItem.id;
            swipeAddRef.current = !selectedIds.has(startId);
          } else {
            swipeAddRef.current = true;
          }
          swipeVisit(e.nativeEvent.pageX, e.nativeEvent.pageY);
        },
        onPanResponderMove: (e) => {
          swipeVisit(e.nativeEvent.pageX, e.nativeEvent.pageY);
        },
        onPanResponderRelease: () => {
          swipeVisitedRef.current = new Set();
        },
        onPanResponderTerminate: () => {
          swipeVisitedRef.current = new Set();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [selectionMode, indexAtGridPoint, mediaMessages, selectedIds, swipeVisit],
  );

  // ── render helpers ──────────────────────────────────────────────────────────

  const renderMediaGrid = () => {
    if (mediaMessages.length === 0) {
      return (
        <EmptyState icon="images-outline" label="No photos or videos" topPad={TAB_BAR_HEIGHT + 40} />
      );
    }
    return (
      <View style={{ flex: 1 }} {...gridPanResponder.panHandlers}>
        <FlatList
          data={mediaMessages}
          numColumns={COLUMN_COUNT}
          keyExtractor={(item) => item.messageId || item.id}
          onScroll={(e) => {
            gridScrollYRef.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          renderItem={({ item, index }) => {
            const id = item.messageId || item.id;
            const isSelected = selectedIds.has(id);
            return (
              <MediaCell
                message={item}
                selectionMode={selectionMode}
                selected={isSelected}
                onPress={() => {
                  if (selectionMode) toggleSelected(id);
                  else openViewer(index);
                }}
                onLongPress={() => {
                  if (!selectionMode) enterSelectionWith(id);
                }}
              />
            );
          }}
          contentContainerStyle={{
            paddingTop: TAB_BAR_HEIGHT + GRID_GAP,
            paddingBottom: insets.bottom + (selectionMode ? 100 : 32),
            paddingHorizontal: GRID_GAP,
            gap: GRID_GAP,
          }}
          columnWrapperStyle={{ gap: GRID_GAP }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          windowSize={10}
          initialNumToRender={18}
        />
      </View>
    );
  };

  const handleDocPress = useCallback(async (message: ChatMessage) => {
    let localPath = message.localMediaPath;
    
    if (!localPath && message.mediaUrl) {
      try {
        const fileName = message.mediaMetadata?.fileName || 'document';
        const dlPath = await getOrDownloadMedia(
          message.mediaUrl,
          message.localMediaPath,
          params.chatId,
          message.messageId || message.id,
          fileName
        );
        if (dlPath) localPath = dlPath;
      } catch (error) {
        console.error('Failed to download doc:', error);
      }
    }

    if (!localPath) {
      Alert.alert('File Not Available', 'The file could not be downloaded.');
      return;
    }

    if (Platform.OS === 'ios') {
      try {
        const QuickLookPreview = require('../../../modules/my-module');
        await QuickLookPreview.previewFile(localPath);
        return;
      } catch (err) {
        console.error('Failed to preview doc with QuickLook Expo Module:', err);
      }
    }

    // @ts-ignore
    navigation.navigate(ROUTES.APP.FILE_PREVIEW, {
      uri: localPath,
      fileName: message.mediaMetadata?.fileName,
      mimeType: message.mediaMetadata?.mimeType,
      fileSize: message.mediaMetadata?.fileSize,
    });
  }, [navigation, params.chatId]);

  const renderDocs = () => {
    if (docMessages.length === 0) {
      return <EmptyState icon="document-outline" label="No documents" topPad={TAB_BAR_HEIGHT + 40} />;
    }
    return (
      <ScrollView
        contentContainerStyle={{
          paddingTop: TAB_BAR_HEIGHT + 16,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + (selectionMode ? 100 : 32),
        }}
        showsVerticalScrollIndicator={false}
      >
        <GlassView style={styles.listCard}>
          {docMessages.map((m) => {
            const id = m.messageId || m.id;
            const isSelected = selectedIds.has(id);
            return (
              <DocRow
                key={id}
                message={m}
                senderName={senderMap.get(m.senderId) ?? 'Member'}
                selectionMode={selectionMode}
                selected={isSelected}
                onPress={() => {
                  if (selectionMode) toggleSelected(id);
                  else handleDocPress(m);
                }}
                onLongPress={() => {
                  if (!selectionMode) enterSelectionWith(id);
                }}
              />
            );
          })}
        </GlassView>
      </ScrollView>
    );
  };

  const renderLinks = () => {
    if (linkMessages.length === 0) {
      return <EmptyState icon="link-outline" label="No links shared" topPad={TAB_BAR_HEIGHT + 40} />;
    }
    return (
      <ScrollView
        contentContainerStyle={{
          paddingTop: TAB_BAR_HEIGHT + 16,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + (selectionMode ? 100 : 32),
        }}
        showsVerticalScrollIndicator={false}
      >
        <GlassView style={styles.listCard}>
          {linkMessages.map((m) => {
            const id = m.messageId || m.id;
            const isSelected = selectedIds.has(id);
            return (
              <LinkRow
                key={id}
                message={m}
                senderName={senderMap.get(m.senderId) ?? 'Member'}
                selectionMode={selectionMode}
                selected={isSelected}
                onPress={() => {
                  if (selectionMode) toggleSelected(id);
                }}
                onLongPress={() => {
                  if (!selectionMode) enterSelectionWith(id);
                }}
              />
            );
          })}
        </GlassView>
      </ScrollView>
    );
  };

  return (
    <LiquidBackground>
      <View style={{ flex: 1 }}>
        {/* Content (renders behind the sticky tab bar) */}
        {activeTab === 'media' && renderMediaGrid()}
        {activeTab === 'docs' && renderDocs()}
        {activeTab === 'links' && renderLinks()}

        {/* Sticky tab bar — sits on top so content scrolls under it */}
        <View
          style={[
            styles.tabBarContainer,
            {
              paddingTop: insets.top + 52,
              backgroundColor: isDark
                ? 'rgba(18,18,18,0.94)'
                : 'rgba(253,251,251,0.94)',
              borderBottomColor: isDark
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(0,0,0,0.08)',
            },
          ]}
        >
          <View style={styles.tabBar}>
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <TouchableOpacity
                  key={tab.id}
                  style={styles.tabItem}
                  onPress={() => handleTabPress(tab.id)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={tab.icon}
                    size={18}
                    color={isActive ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                  <Text
                    style={[
                      styles.tabLabel,
                      {
                        color: isActive
                          ? theme.colors.primary
                          : theme.colors.onSurfaceVariant,
                        fontWeight: isActive ? '700' : '400',
                      },
                    ]}
                  >
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Animated pill indicator */}
          <View style={styles.indicatorTrack}>
            <Animated.View
              style={[
                styles.tabIndicator,
                {
                  backgroundColor: theme.colors.primary,
                  width: tabWidth * 0.4,
                  transform: [
                    {
                      translateX: Animated.add(
                        tabIndicatorX,
                        new Animated.Value(tabWidth * 0.3),
                      ),
                    },
                  ],
                },
              ]}
            />
          </View>
        </View>

        {/* Selection action bar — appears at the bottom while in selection mode. */}
        {selectionMode && (
          <View
            style={[
              styles.selectionBar,
              {
                paddingBottom: insets.bottom + 8,
                backgroundColor: isDark ? 'rgba(18,18,18,0.96)' : 'rgba(253,251,251,0.96)',
                borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
              },
            ]}
          >
            <View style={styles.selectionBarRow}>
              <Text style={[styles.selectionCount, { color: theme.colors.onSurface }]}>
                {selectedIds.size} selected
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {canDeleteForEveryone && (
                  <TouchableOpacity
                    onPress={promptBulkDeleteForEveryone}
                    style={[styles.selectionBarButton, { backgroundColor: theme.colors.errorContainer ?? 'rgba(255,82,82,0.18)' }]}
                  >
                    <Ionicons name="trash-bin-outline" size={18} color={theme.colors.error} />
                    <Text style={[styles.selectionBarButtonText, { color: theme.colors.error }]}>For everyone</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={selectedIds.size === 0 ? undefined : promptBulkDeleteForMe}
                  style={[
                    styles.selectionBarButton,
                    { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', opacity: selectedIds.size === 0 ? 0.4 : 1 },
                  ]}
                  disabled={selectedIds.size === 0}
                >
                  <Ionicons name="trash-outline" size={18} color={theme.colors.error} />
                  <Text style={[styles.selectionBarButtonText, { color: theme.colors.error }]}>For me</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Full-screen viewer modal */}
      <FullScreenViewer
        messages={mediaMessages}
        initialIndex={viewerIndex}
        senderMap={senderMap}
        visible={viewerVisible}
        onClose={() => {
          setViewerVisible(false);
          if (params.initialMessageId) {
            navigation.goBack();
          }
        }}
      />

      {/* Undo snackbar — surfaces after delete-for-me bulk action so the user
          can recover within the undo window if they hit the wrong action. */}
      <Snackbar
        visible={!!undoSnapshot}
        onDismiss={() => setUndoSnapshot(null)}
        duration={DELETE_UNDO_WINDOW_MS}
        action={{
          label: 'Undo',
          onPress: () => {
            void handleUndoBulkDelete();
          },
        }}
        wrapperStyle={{ bottom: insets.bottom + 90 }}
      >
        {undoSnapshot && undoSnapshot.messageIds.length > 1
          ? `${undoSnapshot.messageIds.length} items deleted for you`
          : 'Item deleted for you'}
      </Snackbar>
    </LiquidBackground>
  );
};

// ─── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Tab bar
  tabBarContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBar: {
    flexDirection: 'row',
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  tabLabel: {
    fontSize: 14,
  },
  indicatorTrack: {
    height: 3,
  },
  tabIndicator: {
    height: 3,
    borderRadius: 2,
  },
  // Grid
  cell: {
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: '#111',
  },
  cellImage: {
    width: '100%',
    height: '100%',
  },
  cellPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellVideoOverlay: {
    position: 'absolute',
    bottom: 5,
    left: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  cellDuration: {
    color: '#fff',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  cellSelectCheckbox: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowSelectCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  selectionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  selectionBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  selectionCount: {
    fontSize: 14,
    fontWeight: '600',
  },
  selectionBarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  selectionBarButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
  // Doc / link list
  listCard: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  docIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  docInfo: {
    flex: 1,
    gap: 2,
  },
  docName: {
    fontSize: 14,
    fontWeight: '500',
  },
  docMeta: {
    fontSize: 11,
  },
  // Empty state
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 15,
  },
  // Zoomable image — fills the screen so pinch focal math is accurate
  zoomableContainer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomableImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  // Full-screen video — fills the viewport so portrait videos use vertical space
  // properly. Native controls overlay above the video; the chat chrome
  // (close/info) sits in its own bar with `pointerEvents="auto"` so it stays tappable.
  videoPlayer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  // Full-screen viewer
  viewerRoot: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  viewerBackdrop: {
    backgroundColor: '#000',
  },
  viewerMedia: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Off-screen, zero-opacity preloader — lets us warm the RN image cache for
  // the prev/next item without it being seen by the user.
  preloadImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    opacity: 0,
  },
  viewerTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  viewerNavButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerBottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    backgroundColor: 'rgba(0,0,0,0.42)',
    gap: 2,
  },
  viewerCounter: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  viewerSender: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
    textAlign: 'center',
  },
  viewerDate: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    textAlign: 'center',
  },
  viewerArrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -22,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 22,
  },
  viewerArrowLeft: { left: 12 },
  viewerArrowRight: { right: 12 },
  // Bottom thumb strip
  thumbStripContent: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: STRIP_THUMB_GAP,
  },
  stripThumb: {
    width: STRIP_THUMB_SIZE,
    height: STRIP_THUMB_SIZE,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
  },
  stripThumbImage: {
    width: '100%',
    height: '100%',
  },
  stripThumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripThumbVideoBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Info panel
  infoPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: SCREEN_HEIGHT * 0.62,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 20,
  },
  infoPanelHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.38)',
    alignSelf: 'center',
    marginBottom: 12,
  },
  infoPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 11,
    gap: 14,
  },
  infoIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  infoRowContent: {
    flex: 1,
    gap: 1,
  },
  infoLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
  },
});

export default ChatMediaGalleryScreen;
