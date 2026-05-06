import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatParticipant, MediaMetadata } from '@/models';
import { ROUTES } from '@/constants';
import { mediaExistsLocally, getOrDownloadMedia } from '@/services/mediaService';
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
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── constants ───────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const GRID_GAP = 2;
const CELL_SIZE = (SCREEN_WIDTH - GRID_GAP * (COLUMN_COUNT + 1)) / COLUMN_COUNT;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
// Extra top inset so native video controls clear the top chrome (close / info buttons)
const VIDEO_TOP_INSET = 100;

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
      const swipeNext =
        horizDominant &&
        hasNext &&
        (e.translationX < -SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX < -SWIPE_VELOCITY_THRESHOLD);
      const swipePrev =
        horizDominant &&
        hasPrev &&
        (e.translationX > SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX > SWIPE_VELOCITY_THRESHOLD);

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
        translateX.value = withTiming(-SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipeNext)();
        });
      } else if (swipePrev) {
        translateX.value = withTiming(SCREEN_WIDTH, TIMING_FAST, () => {
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
  onSingleTap,
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
      const swipeNext =
        horizDominant &&
        hasNext &&
        (e.translationX < -SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX < -SWIPE_VELOCITY_THRESHOLD);
      const swipePrev =
        horizDominant &&
        hasPrev &&
        (e.translationX > SWIPE_DISTANCE_THRESHOLD ||
          e.velocityX > SWIPE_VELOCITY_THRESHOLD);

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
        translateX.value = withTiming(-SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipeNext)();
        });
      } else if (swipePrev) {
        translateX.value = withTiming(SCREEN_WIDTH, TIMING_FAST, () => {
          runOnJS(onSwipePrev)();
        });
      } else {
        translateX.value = withSpring(0, SPRING);
        translateY.value = withSpring(0, SPRING);
        scaleVal.value = withSpring(1, SPRING);
        backdropOpacity.value = withSpring(1, SPRING);
      }
    });

  // Long-press / single-tap to toggle chrome — short, low-priority so it does
  // not steal taps that should reach the native player chrome.
  const tap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(220)
    .onEnd(() => {
      'worklet';
      runOnJS(onSingleTap)();
    });

  // Pan and tap don't conflict (different shapes) — race so whichever resolves first wins.
  const composed = Gesture.Race(pan, tap);

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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
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
          <Image
            source={{ uri: prevPreloadUri }}
            style={styles.preloadImage}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}
        {nextPreloadUri ? (
          <Image
            source={{ uri: nextPreloadUri }}
            style={styles.preloadImage}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
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
          pointerEvents="none"
        >
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
}

const MediaCell = React.memo(({ message, onPress }: MediaCellProps) => {
  const { theme } = useTheme();
  const { uri, markFailed } = useResolvedMediaUri(message);
  const isVideo = message.type === 'video';
  const duration = message.mediaMetadata?.duration;

  return (
    <TouchableOpacity
      style={[styles.cell, { width: CELL_SIZE, height: CELL_SIZE }]}
      onPress={onPress}
      activeOpacity={0.82}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={styles.cellImage}
          resizeMode="cover"
          onError={markFailed}
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
      {isVideo && (
        <View style={styles.cellVideoOverlay}>
          <Ionicons name="play" size={12} color="#fff" />
          {duration ? (
            <Text style={styles.cellDuration}>{formatDuration(duration)}</Text>
          ) : null}
        </View>
      )}
    </TouchableOpacity>
  );
});

// ─── DocRow ───────────────────────────────────────────────────────────────────

interface DocRowProps {
  message: ChatMessage;
  senderName: string;
  onPress?: () => void;
}

const DocRow = React.memo(({ message, senderName, onPress }: DocRowProps) => {
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
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
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
      <Ionicons name="chevron-forward" size={16} color={theme.colors.onSurfaceVariant} />
    </TouchableOpacity>
  );
});

// ─── LinkRow ──────────────────────────────────────────────────────────────────

interface LinkRowProps {
  message: ChatMessage;
  senderName: string;
}

const LinkRow = React.memo(({ message, senderName }: LinkRowProps) => {
  const { theme, isDark } = useTheme();
  const matches = message.content.match(URL_REGEX) ?? [];

  return (
    <>
      {matches.map((url, i) => (
        <View
          key={`${message.messageId}_${i}`}
          style={[
            styles.docRow,
            {
              borderBottomColor: isDark
                ? 'rgba(255,255,255,0.06)'
                : 'rgba(0,0,0,0.06)',
            },
          ]}
        >
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
        </View>
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
  const { subscribeToMessages } = useChat();
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('media');
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const autoOpenedRef = useRef(false);

  // Animated tab indicator
  const tabIndicatorX = useRef(new Animated.Value(0)).current;
  const tabWidth = SCREEN_WIDTH / TABS.length;

  useLayoutEffect(() => {
    navigation.setOptions({ title: params.title ?? 'Media', headerTransparent: true });
  }, [navigation, params.title]);

  useEffect(() => {
    if (!params.chatId) return;
    const unsubscribe = subscribeToMessages(params.chatId, (items) => {
      setMessages(items);
    });
    return unsubscribe;
  }, [params.chatId, subscribeToMessages]);

  // Derived lists — exclude messages the current user has hidden via "Delete for me".
  const visibleMessages = useMemo(
    () => (user ? messages.filter((m) => !m.deletedFor?.includes(user.userId)) : messages),
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

  const handleTabPress = useCallback(
    (tab: TabId) => {
      setActiveTab(tab);
      Animated.spring(tabIndicatorX, {
        toValue: TAB_INDEX[tab] * tabWidth,
        useNativeDriver: true,
        damping: 20,
        stiffness: 200,
      }).start();
    },
    [tabIndicatorX, tabWidth],
  );

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

  // ── render helpers ──────────────────────────────────────────────────────────

  const renderMediaGrid = () => {
    if (mediaMessages.length === 0) {
      return (
        <EmptyState icon="images-outline" label="No photos or videos" topPad={TAB_BAR_HEIGHT + 40} />
      );
    }
    return (
      <FlatList
        data={mediaMessages}
        numColumns={COLUMN_COUNT}
        keyExtractor={(item) => item.messageId || item.id}
        renderItem={({ item, index }) => (
          <MediaCell message={item} onPress={() => openViewer(index)} />
        )}
        contentContainerStyle={{
          paddingTop: TAB_BAR_HEIGHT + GRID_GAP,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: GRID_GAP,
          gap: GRID_GAP,
        }}
        columnWrapperStyle={{ gap: GRID_GAP }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        windowSize={10}
        initialNumToRender={18}
      />
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
          paddingBottom: insets.bottom + 32,
        }}
        showsVerticalScrollIndicator={false}
      >
        <GlassView style={styles.listCard}>
          {docMessages.map((m) => (
            <DocRow
              key={m.messageId || m.id}
              message={m}
              senderName={senderMap.get(m.senderId) ?? 'Member'}
              onPress={() => handleDocPress(m)}
            />
          ))}
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
          paddingBottom: insets.bottom + 32,
        }}
        showsVerticalScrollIndicator={false}
      >
        <GlassView style={styles.listCard}>
          {linkMessages.map((m) => (
            <LinkRow
              key={m.messageId || m.id}
              message={m}
              senderName={senderMap.get(m.senderId) ?? 'Member'}
            />
          ))}
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
  // Video player — inset from top so native controls don't overlap close/info buttons
  videoPlayer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT - VIDEO_TOP_INSET,
    marginTop: VIDEO_TOP_INSET,
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
