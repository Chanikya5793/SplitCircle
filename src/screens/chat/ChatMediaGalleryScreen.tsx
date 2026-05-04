import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, ChatParticipant, MediaMetadata } from '@/models';
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
  useAnimatedStyle,
  useSharedValue,
  withSpring,
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

// ─── tab config ───────────────────────────────────────────────────────────────

type TabId = 'media' | 'docs' | 'links';

const TABS: { id: TabId; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'media', label: 'Media', icon: 'images-outline' },
  { id: 'docs', label: 'Docs', icon: 'document-outline' },
  { id: 'links', label: 'Links', icon: 'link-outline' },
];

// ─── ZoomableImage (RNGH v2 + Reanimated) ────────────────────────────────────

interface ZoomableImageProps {
  uri: string;
}

const ZoomableImage = ({ uri }: ZoomableImageProps) => {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const lastTapTs = useSharedValue(0);

  const clampTranslation = (val: number, s: number, dimension: number) => {
    const max = ((s - 1) * dimension) / 2;
    return Math.max(-max, Math.min(max, val));
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      if (scale.value < MIN_SCALE) {
        scale.value = withSpring(MIN_SCALE);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedScale.value = MIN_SCALE;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        savedScale.value = scale.value;
      }
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .onUpdate((e) => {
      if (scale.value <= 1) return;
      translateX.value = clampTranslation(
        savedTranslateX.value + e.translationX,
        scale.value,
        SCREEN_WIDTH,
      );
      translateY.value = clampTranslation(
        savedTranslateY.value + e.translationY,
        scale.value,
        SCREEN_HEIGHT,
      );
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withSpring(1);
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        scale.value = withSpring(2.5);
        savedScale.value = 2.5;
      }
    });

  const composed = Gesture.Simultaneous(
    Gesture.Race(doubleTap, pan),
    pinch,
  );

  const animStyle = useAnimatedStyle(() => ({
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
        />
      </Reanimated.View>
    </GestureDetector>
  );
};

// ─── FullScreenVideoPlayer ────────────────────────────────────────────────────

const FullScreenVideoPlayer = ({ uri }: { uri: string }) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  return (
    <VideoView
      player={player}
      style={styles.zoomableImage}
      contentFit="contain"
      nativeControls
    />
  );
};

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
      damping: 22,
      stiffness: 190,
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

  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      setShowInfo(false);
      setShowChrome(true);
      fadeAnim.setValue(1);
    }
  }, [initialIndex, visible, fadeAnim]);

  const toggleChrome = useCallback(() => {
    const next = !showChrome;
    setShowChrome(next);
    Animated.timing(fadeAnim, {
      toValue: next ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [showChrome, fadeAnim]);

  if (!visible || messages.length === 0) return null;

  const msg = messages[currentIndex];
  if (!msg) return null;

  const senderName = senderMap.get(msg.senderId) ?? 'Unknown';
  const isVideo = msg.type === 'video';
  const mediaUri = msg.localMediaPath ?? msg.mediaUrl;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerRoot}>
        {/* Media area — tap to toggle chrome */}
        <TouchableOpacity
          style={styles.viewerMedia}
          activeOpacity={1}
          onPress={toggleChrome}
        >
          {mediaUri ? (
            isVideo ? (
              <FullScreenVideoPlayer uri={mediaUri} />
            ) : (
              <ZoomableImage uri={mediaUri} />
            )
          ) : (
            <View style={styles.viewerPlaceholder}>
              <Ionicons name="cloud-offline-outline" size={48} color="#666" />
              <Text style={{ color: '#666', marginTop: 8 }}>Media unavailable</Text>
            </View>
          )}
        </TouchableOpacity>

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

        {/* Prev / next arrows */}
        {currentIndex > 0 && showChrome && (
          <TouchableOpacity
            style={[styles.viewerArrow, styles.viewerArrowLeft]}
            onPress={() => { setCurrentIndex((i) => i - 1); setShowInfo(false); }}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={30} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
        )}
        {currentIndex < messages.length - 1 && showChrome && (
          <TouchableOpacity
            style={[styles.viewerArrow, styles.viewerArrowRight]}
            onPress={() => { setCurrentIndex((i) => i + 1); setShowInfo(false); }}
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
  const uri = message.localMediaPath ?? message.mediaUrl;
  const isVideo = message.type === 'video';
  const duration = message.mediaMetadata?.duration;

  return (
    <TouchableOpacity
      style={[styles.cell, { width: CELL_SIZE, height: CELL_SIZE }]}
      onPress={onPress}
      activeOpacity={0.82}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.cellImage} resizeMode="cover" />
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

  // Derived lists
  const mediaMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          (m.type === 'image' || m.type === 'video') &&
          (m.localMediaPath || m.mediaUrl),
      ),
    [messages],
  );

  const docMessages = useMemo(
    () => messages.filter((m) => m.type === 'file' || m.type === 'audio'),
    [messages],
  );

  const linkMessages = useMemo(
    () => messages.filter((m) => m.type === 'text' && URL_REGEX.test(m.content)),
    [messages],
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
        onClose={() => setViewerVisible(false)}
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
  // Zoomable image
  zoomableContainer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomableImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
  },
  // Full-screen viewer
  viewerRoot: {
    flex: 1,
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
