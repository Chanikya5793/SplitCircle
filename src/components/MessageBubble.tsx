import { LinkPreview } from '@/components/Chat/LinkPreview';
import { MapErrorBoundary } from '@/components/Chat/MapErrorBoundary';
import { ReactionsRow } from '@/components/Chat/ReactionsRow';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, MessageStatus, MessageType, UrlPreview } from '@/models';
import { extractFirstUrl, fetchLinkPreview } from '@/services/linkPreviewService';
import { updateMessageUrlPreview } from '@/services/localMessageStorage';
import { downloadMedia, mediaExistsLocally } from '@/services/mediaService';
import { formatRelativeTime } from '@/utils/format';
import { hasGoogleMapsApiKey } from '@/utils/hasGoogleMapsApiKey';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, Image, Linking, Modal, Platform, Pressable, StyleSheet, TouchableOpacity, View, ViewStyle } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Avatar, IconButton, Text } from 'react-native-paper';

// Lazy load MapView to prevent crashes in production builds
const MapView = React.lazy(() => import('react-native-maps').then(mod => ({ default: mod.default })));
const Marker = React.lazy(() => import('react-native-maps').then(mod => ({ default: mod.Marker })));

interface MessageBubbleProps {
  message: ChatMessage;
  showSenderInfo?: boolean;
  senderName?: string;
  onSwipeReply?: (message: ChatMessage) => void;
  onSwipeInfo?: (message: ChatMessage) => void;
  onReplyPress?: (messageId: string) => void;
  /** When provided, tapping an image bubble defers to this handler instead of opening the local fullscreen modal. Used to route into the chat media gallery. */
  onMediaPress?: (message: ChatMessage) => void;
  /** Long-press anywhere on the bubble. Opens the action sheet in ChatRoomScreen. */
  onLongPress?: (message: ChatMessage) => void;
  /** Tap on an existing reactions chip to open the reaction details / picker. */
  onReactionsPress?: (message: ChatMessage) => void;
  /** Tap on a document bubble — opens the in-app FilePreviewScreen. */
  onFilePress?: (message: ChatMessage) => void;
  /** Double-tap on the bubble — used for quick ❤️ reaction. */
  onDoubleTap?: (message: ChatMessage) => void;
  /** When in selection mode, every tap toggles selection instead of doing the default action. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (message: ChatMessage) => void;
  /** Tap a mention in this bubble — opens that user's profile. */
  onMentionPress?: (userId: string) => void;
  /** Search query to highlight inside the message text. */
  searchQuery?: string;
  /** Map of userId → display name; used to render mentions as @Name. */
  mentionLabels?: Map<string, string>;
  isGroupChat?: boolean;
  totalRecipients?: number;
  highlighted?: boolean;
  /** Used to dim the row when an action sheet is anchored to a different message — gives the focused-bubble feel. */
  dimmed?: boolean;
}

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D'
];

// Pre-compute stable waveform heights so Math.random() doesn't run on every render
const WAVEFORM_HEIGHTS = Array.from({ length: 16 }, () => Math.random() * 16 + 4);

const getSenderColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MAX_IMAGE_WIDTH = SCREEN_WIDTH * 0.65;
const MAX_IMAGE_HEIGHT = 300;

// Tokenize a chat message body into mention / link / search-match / text spans.
type Span =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'highlight'; text: string };

const URL_PATTERN = /(\bhttps?:\/\/[^\s<>"']+)/gi;
const MENTION_PATTERN = /@([a-zA-Z0-9_-]{1,40})/g;

const splitMentions = (text: string, mentionLabels?: Map<string, string>): Span[] => {
  if (!text) return [];
  if (!mentionLabels || mentionLabels.size === 0) {
    return [{ kind: 'text', text }];
  }
  // Build a lookup keyed by lowercased display-name (without spaces) → userId
  // so "@alice" and "@AliceJones" both resolve.
  const byLabel = new Map<string, string>();
  mentionLabels.forEach((name, userId) => {
    byLabel.set(name.replace(/\s+/g, '').toLowerCase(), userId);
    byLabel.set(userId.toLowerCase(), userId);
  });

  const spans: Span[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const candidate = match[1].toLowerCase();
    const userId = byLabel.get(candidate);
    if (!userId) continue;
    if (match.index === undefined) continue;
    if (match.index > lastIndex) {
      spans.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    spans.push({ kind: 'mention', text: match[0], userId });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    spans.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return spans.length ? spans : [{ kind: 'text', text }];
};

const splitLinks = (spans: Span[]): Span[] => {
  const out: Span[] = [];
  for (const span of spans) {
    if (span.kind !== 'text') {
      out.push(span);
      continue;
    }
    let lastIndex = 0;
    for (const match of span.text.matchAll(URL_PATTERN)) {
      if (match.index === undefined) continue;
      if (match.index > lastIndex) {
        out.push({ kind: 'text', text: span.text.slice(lastIndex, match.index) });
      }
      out.push({ kind: 'link', text: match[0], url: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < span.text.length) {
      out.push({ kind: 'text', text: span.text.slice(lastIndex) });
    }
  }
  return out;
};

const splitHighlights = (spans: Span[], query?: string): Span[] => {
  const q = (query ?? '').trim();
  if (!q) return spans;
  const lower = q.toLowerCase();
  const out: Span[] = [];
  for (const span of spans) {
    if (span.kind !== 'text') {
      out.push(span);
      continue;
    }
    const text = span.text;
    let cursor = 0;
    let idx = text.toLowerCase().indexOf(lower);
    while (idx !== -1) {
      if (idx > cursor) out.push({ kind: 'text', text: text.slice(cursor, idx) });
      out.push({ kind: 'highlight', text: text.slice(idx, idx + q.length) });
      cursor = idx + q.length;
      idx = text.toLowerCase().indexOf(lower, cursor);
    }
    if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  }
  return out;
};

const tokenizeContent = (
  text: string,
  mentionLabels?: Map<string, string>,
  searchQuery?: string,
): Span[] => splitHighlights(splitLinks(splitMentions(text, mentionLabels)), searchQuery);

// Helper to format file size
const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Helper to format duration
const formatDuration = (ms?: number): string => {
  if (!ms) return '';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

// Get icon for message type (used in reply previews)
const getMediaIcon = (type?: MessageType): keyof typeof Ionicons.glyphMap => {
  switch (type) {
    case 'image': return 'image';
    case 'video': return 'videocam';
    case 'audio': return 'musical-notes';
    case 'file': return 'document';
    case 'location': return 'location';
    default: return 'chatbubble';
  }
};

// Get document icon based on mime type
const getDocumentIcon = (mimeType?: string): keyof typeof Ionicons.glyphMap => {
  if (!mimeType) return 'document';
  if (mimeType.startsWith('application/pdf')) return 'document-text';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'grid';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'easel';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document-text';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return 'archive';
  return 'document';
};

// WhatsApp-style message status indicator component
const MessageStatusIndicator = ({ status, isGroupChat: _isGroupChat, totalRecipients: _totalRecipients, deliveredCount, readCount }: {
  status: MessageStatus;
  isGroupChat?: boolean;
  totalRecipients?: number;
  deliveredCount?: number;
  readCount?: number;
}) => {
  const delivered = deliveredCount ?? 0;
  const read = readCount ?? 0;

  if (status === 'sending') {
    return <Ionicons name="time-outline" size={14} color="rgba(255,255,255,0.6)" style={styles.statusIconSingle} />;
  }

  if (status === 'failed') {
    return <Ionicons name="alert-circle-outline" size={14} color="#FF6B6B" style={styles.statusIconSingle} />;
  }

  const hasAnyRead = read > 0 || status === 'read';
  const hasAnyDelivered = hasAnyRead || delivered > 0 || status === 'delivered';

  if (!hasAnyDelivered) {
    return <Ionicons name="checkmark" size={14} color="rgba(255,255,255,0.7)" style={styles.statusIconSingle} />;
  }

  const tickColor = hasAnyRead ? '#35C6FF' : 'rgba(255,255,255,0.7)';
  return (
    <View style={styles.statusDoubleTick}>
      <Ionicons name="checkmark" size={13} color={tickColor} style={styles.statusTickBack} />
      <Ionicons name="checkmark" size={13} color={tickColor} style={styles.statusTickFront} />
    </View>
  );
};

// Video player component using expo-video
interface VideoPlayerComponentProps {
  uri: string;
  style: ViewStyle | ViewStyle[];
  showControls?: boolean;
  showOverlay?: boolean;
}

const VideoPlayerComponent = ({ uri, style, showControls = true, showOverlay = false }: VideoPlayerComponentProps) => {
  const player = useVideoPlayer(uri, (player) => {
    player.loop = false;
  });

  return (
    <View style={style}>
      <VideoView
        player={player}
        style={{ width: '100%', height: '100%' }}
        contentFit="cover"
        nativeControls={showControls}
      />
      {showOverlay && (
        <View style={styles.uploadingOverlay}>
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}
    </View>
  );
};

export const MessageBubble = ({ message, showSenderInfo, senderName, onSwipeReply, onSwipeInfo, onReplyPress, onMediaPress, onLongPress, onReactionsPress, onFilePress, onDoubleTap, selectionMode, selected, onToggleSelect, onMentionPress, searchQuery, mentionLabels, isGroupChat, totalRecipients, highlighted, dimmed }: MessageBubbleProps) => {
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [fullScreenVisible, setFullScreenVisible] = useState(false);
  const highlightAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!highlighted) return;
    Animated.sequence([
      Animated.timing(highlightAnim, { toValue: 1, duration: 200, useNativeDriver: false }),
      Animated.delay(600),
      Animated.timing(highlightAnim, { toValue: 0, duration: 400, useNativeDriver: false }),
    ]).start();
  }, [highlighted, highlightAnim]);

  // Audio playback state
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const audioStatusListenerRef = useRef<{ remove: () => void } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Release player resources on unmount
  useEffect(() => {
    return () => {
      audioStatusListenerRef.current?.remove();
      audioStatusListenerRef.current = null;
      audioPlayerRef.current?.remove();
      audioPlayerRef.current = null;
    };
  }, []);

  const handlePlayPause = async () => {
    if (!mediaUri) return;

    try {
      const existingPlayer = audioPlayerRef.current;
      if (existingPlayer) {
        if (isPlaying || existingPlayer.playing) {
          existingPlayer.pause();
          setIsPlaying(false);
        } else {
          existingPlayer.play();
          setIsPlaying(true);
        }
      } else {
        // Configure audio session for playback
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        });

        const newPlayer = createAudioPlayer(mediaUri, { updateInterval: 250 });
        audioStatusListenerRef.current?.remove();
        audioStatusListenerRef.current = newPlayer.addListener('playbackStatusUpdate', (status: AudioStatus) => {
          if (!status.isLoaded) {
            return;
          }

          setIsPlaying(status.playing);
          if (status.didJustFinish) {
            setIsPlaying(false);
            newPlayer.seekTo(0).catch((seekError) => {
              console.warn('Failed to reset audio player position:', seekError);
            });
          }
        });
        audioPlayerRef.current = newPlayer;
        newPlayer.play();
        setIsPlaying(true);
      }
    } catch (error) {
      console.error('Error playing audio:', error);
      Alert.alert('Error', 'Could not play audio message.');
    }
  };

  const resetAudioPlayer = () => {
    if (!audioPlayerRef.current) {
      return;
    }
    audioStatusListenerRef.current?.remove();
    audioStatusListenerRef.current = null;
    audioPlayerRef.current.remove();
    audioPlayerRef.current = null;
    setIsPlaying(false);
  };

  if (message.type === 'system') {
    return (
      <View style={styles.systemContainer}>
        <View style={[styles.systemBubble, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)' }]}>
          <Text style={[styles.systemText, { color: theme.colors.onSurfaceVariant }]}>{message.content}</Text>
        </View>
      </View>
    );
  }

  // If the user "deleted for me", swap the bubble for a tombstone — keeps the
  // ordering stable so reply jumps still land in the right place.
  if (user && message.deletedFor?.includes(user.userId)) {
    return (
      <View style={styles.systemContainer}>
        <View style={[styles.systemBubble, styles.tombstoneBubble, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)' }]}>
          <Ionicons name="trash-outline" size={11} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.systemText, { color: theme.colors.onSurfaceVariant }]}>You deleted this message</Text>
        </View>
      </View>
    );
  }

  // Delete-for-everyone tombstone — visible to all participants once the
  // sender's mark propagates. We keep the bubble layout (mine / other) so the
  // chat keeps its rhythm.
  if (message.deletedForEveryone) {
    const youDeleted = user?.userId === message.senderId;
    return (
      <View style={styles.systemContainer}>
        <View style={[styles.systemBubble, styles.tombstoneBubble, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)' }]}>
          <Ionicons name="ban-outline" size={11} color={theme.colors.onSurfaceVariant} />
          <Text style={[styles.systemText, { color: theme.colors.onSurfaceVariant }]}>
            {youDeleted ? 'You deleted this message' : 'This message was deleted'}
          </Text>
        </View>
      </View>
    );
  }

  const isMine = user?.userId === message.senderId;
  const senderColor = !isMine && message.senderId ? getSenderColor(message.senderId) : theme.colors.primary;
  const initials = senderName ? senderName.slice(0, 2).toUpperCase() : '??';

  // Calculate image dimensions maintaining aspect ratio
  const getImageDimensions = useCallback(() => {
    const metadata = message.mediaMetadata;
    if (metadata?.width && metadata?.height) {
      const aspectRatio = metadata.width / metadata.height;
      let width = Math.min(metadata.width, MAX_IMAGE_WIDTH);
      let height = width / aspectRatio;

      if (height > MAX_IMAGE_HEIGHT) {
        height = MAX_IMAGE_HEIGHT;
        width = height * aspectRatio;
      }

      return { width, height };
    }
    return { width: MAX_IMAGE_WIDTH, height: 200 };
  }, [message.mediaMetadata]);

  const imageDimensions = getImageDimensions();

  const renderLeftActions = (_progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>) => {
    const scale = dragX.interpolate({
      inputRange: [0, 50],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });

    return (
      <View style={styles.replyActionContainer}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <IconButton icon="reply" iconColor={theme.colors.onSurface} size={20} />
        </Animated.View>
      </View>
    );
  };

  const renderRightActions = (_progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>) => {
    const scale = dragX.interpolate({
      inputRange: [-50, 0],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });

    return (
      <View style={styles.infoActionContainer}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Ionicons name="information-circle-outline" size={22} color={theme.colors.primary} />
        </Animated.View>
      </View>
    );
  };

  const onSwipeableOpen = (direction: 'left' | 'right') => {
    if (direction === 'left' && onSwipeReply) {
      onSwipeReply(message);
    } else if (direction === 'right' && isGroupChat && onSwipeInfo) {
      onSwipeInfo(message);
    }
    swipeableRef.current?.close();
  };

  // Reply preview component
  const renderReplyContent = () => {
    if (!message.replyTo) return null;
    const replyColor = getSenderColor(message.replyTo.senderId);
    const isMediaReply = message.replyTo.type && message.replyTo.type !== 'text';

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => onReplyPress?.(message.replyTo!.messageId)}
        style={[styles.replyContainer, {
          borderLeftColor: replyColor,
          backgroundColor: isMine ? 'rgba(0,0,0,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)')
        }]}
      >
        <Text style={[styles.replySender, { color: isMine ? 'rgba(255,255,255,0.9)' : replyColor }]}>{message.replyTo.senderName}</Text>
        <View style={styles.replyContentRow}>
          {isMediaReply && (
            <Ionicons
              name={getMediaIcon(message.replyTo.type)}
              size={14}
              color={isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant}
              style={{ marginRight: 4 }}
            />
          )}
          <Text numberOfLines={1} style={[styles.replyText, {
            color: isMine ? 'rgba(255,255,255,0.8)' : theme.colors.onSurfaceVariant
          }]}>
            {message.replyTo.content}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // Get the media URI - prefer local path over remote URL
  // Also handles automatic downloading for received media
  const [mediaUri, setMediaUri] = useState<string | undefined>(
    message.localMediaPath || message.mediaUrl
  );
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  useEffect(() => {
    // Replace player when message/media source changes.
    return () => {
      resetAudioPlayer();
    };
  }, [mediaUri]);

  // Check and download media if needed
  useEffect(() => {
    const checkAndDownloadMedia = async () => {
      // Skip if no media or already have local path
      if (message.type === 'text' || message.type === 'system' || message.type === 'call') {
        return;
      }

      // If we already have a local path, check if it exists
      if (message.localMediaPath) {
        const exists = await mediaExistsLocally(message.localMediaPath);
        if (exists) {
          setMediaUri(message.localMediaPath);
          return;
        }
      }

      // If we have a remote URL but no local file, download it
      if (message.mediaUrl && !message.isFromMe) {
        setIsDownloading(true);
        setDownloadError(false);
        try {
          const fileName = message.mediaMetadata?.fileName || `${message.type}_${message.messageId}`;
          const result = await downloadMedia(
            message.mediaUrl,
            message.chatId,
            message.messageId || message.id,
            fileName
          );
          setMediaUri(result.localPath);
          console.log('✅ Media downloaded for message:', message.messageId);
        } catch (error) {
          console.error('❌ Failed to download media:', error);
          setDownloadError(true);
          // Fall back to remote URL
          setMediaUri(message.mediaUrl);
        } finally {
          setIsDownloading(false);
        }
      } else if (message.mediaUrl) {
        // For sender's messages, use mediaUrl if local path doesn't exist
        setMediaUri(message.mediaUrl);
      }
    };

    checkAndDownloadMedia();
  }, [message.localMediaPath, message.mediaUrl, message.type, message.isFromMe, message.chatId, message.messageId, message.id, message.mediaMetadata?.fileName]);

  // Link preview — fire once per message when text contains a URL and we
  // don't already have a preview in storage. Persists via storage helper so
  // reopening the chat doesn't refetch.
  const detectedUrl = useMemo(
    () => (message.type === 'text' || !message.type ? extractFirstUrl(message.content) : null),
    [message.type, message.content],
  );
  const [livePreview, setLivePreview] = useState<UrlPreview | undefined>(message.urlPreview);

  useEffect(() => {
    setLivePreview(message.urlPreview);
  }, [message.urlPreview]);

  useEffect(() => {
    if (!detectedUrl) return;
    if (livePreview && livePreview.url === detectedUrl) return;
    let cancelled = false;
    (async () => {
      const preview = await fetchLinkPreview(detectedUrl);
      if (cancelled) return;
      setLivePreview(preview);
      const messageId = message.messageId || message.id;
      if (messageId) {
        void updateMessageUrlPreview(message.chatId, messageId, preview);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detectedUrl, livePreview, message.chatId, message.messageId, message.id]);

  // Image content with loading state
  const renderImageContent = () => {
    if (!mediaUri && !isDownloading) return null;

    // Show sending state
    if (message.status === 'sending' && mediaUri) {
      return (
        <View style={[styles.mediaContainer, imageDimensions]}>
          <Image
            source={{ uri: mediaUri }}
            style={[styles.mediaImage, imageDimensions]}
            resizeMode="cover"
          />
          <View style={styles.uploadingOverlay}>
            <ActivityIndicator color="#fff" size="large" />
          </View>
        </View>
      );
    }

    // Show downloading placeholder
    if (isDownloading) {
      return (
        <View style={[styles.mediaContainer, imageDimensions, styles.downloadingContainer]}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text style={styles.downloadingText}>Downloading...</Text>
        </View>
      );
    }

    // Show error state
    if (downloadError && !mediaUri) {
      return (
        <View style={[styles.mediaContainer, imageDimensions, styles.downloadingContainer]}>
          <Ionicons name="cloud-offline-outline" size={40} color={theme.colors.error} />
          <Text style={[styles.downloadingText, { color: theme.colors.error }]}>
            Failed to download
          </Text>
        </View>
      );
    }

    const meta = message.mediaMetadata;
    const resolutionLabel = meta?.width && meta?.height
      ? `${meta.width} × ${meta.height}`
      : null;

    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => {
          if (onMediaPress) {
            onMediaPress(message);
          } else {
            setFullScreenVisible(true);
          }
        }}
        style={[styles.mediaContainer, imageDimensions]}
      >
        {imageLoading && (
          <View style={[styles.imagePlaceholder, imageDimensions]}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        )}
        <Image
          source={{ uri: mediaUri }}
          style={[styles.mediaImage, imageDimensions]}
          resizeMode="cover"
          onLoadStart={() => setImageLoading(true)}
          onLoadEnd={() => setImageLoading(false)}
        />
        {resolutionLabel && !imageLoading && (
          <View style={styles.resolutionBadge}>
            <Text style={styles.resolutionText}>{resolutionLabel}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Video content with player
  const renderVideoContent = () => {
    if (!mediaUri && !isDownloading) return null;

    // Show sending state
    if (message.status === 'sending' && mediaUri) {
      return (
        <VideoPlayerComponent
          uri={mediaUri}
          style={[styles.mediaContainer, styles.mediaVideo, imageDimensions]}
          showControls={false}
          showOverlay={true}
        />
      );
    }

    // Show downloading placeholder
    if (isDownloading) {
      return (
        <View style={[styles.mediaContainer, imageDimensions, styles.downloadingContainer]}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text style={styles.downloadingText}>Downloading video...</Text>
        </View>
      );
    }

    // Return null if no media URI available
    if (!mediaUri) return null;

    return (
      <View style={[styles.mediaContainer, imageDimensions]}>
        <VideoPlayerComponent
          uri={mediaUri}
          style={[styles.mediaVideo, imageDimensions]}
          showControls={true}
        />
        {message.mediaMetadata?.duration && (
          <View style={styles.videoDuration}>
            <Ionicons name="play" size={10} color="#fff" />
            <Text style={styles.videoDurationText}>
              {formatDuration(message.mediaMetadata.duration)}
            </Text>
          </View>
        )}
      </View>
    );
  };

  const handleOpenDocument = () => {
    if (!mediaUri) {
      Alert.alert('File Not Available', 'The file has not been downloaded yet.');
      return;
    }
    onFilePress?.(message);
  };

  // Document attachment
  const renderDocumentContent = () => {
    if (!mediaUri && !message.mediaMetadata && !isDownloading) return null;
    const metadata = message.mediaMetadata;
    const isDownloaded = !!mediaUri && !isDownloading;
    const isSending = message.status === 'sending';

    return (
      <TouchableOpacity
        style={[styles.documentContainer, {
          backgroundColor: isMine ? 'rgba(0,0,0,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)')
        }]}
        activeOpacity={0.7}
        onPress={handleOpenDocument}
        disabled={isDownloading || isSending}
      >
        <View style={[styles.documentIconContainer, { backgroundColor: theme.colors.primary }]}>
          {isDownloading || isSending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons
              name={getDocumentIcon(metadata?.mimeType)}
              size={24}
              color="#fff"
            />
          )}
        </View>
        <View style={styles.documentInfo}>
          <Text
            numberOfLines={1}
            style={[styles.documentName, { color: isMine ? '#fff' : theme.colors.onSurface }]}
          >
            {metadata?.fileName || 'Document'}
          </Text>
          <Text style={[styles.documentSize, { color: isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant }]}>
            {isDownloading ? 'Downloading...' : (metadata?.fileSize ? formatFileSize(metadata.fileSize) : '')}
          </Text>
        </View>
        <Ionicons
          name={isDownloaded ? "open-outline" : "cloud-download-outline"}
          size={20}
          color={isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant}
        />
      </TouchableOpacity>
    );
  };

  // Audio message
  const renderAudioContent = () => {
    if (!mediaUri) return null;
    const metadata = message.mediaMetadata;

    return (
      <View style={[styles.audioContainer, {
        backgroundColor: isMine ? 'rgba(0,0,0,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)')
      }]}>
        <TouchableOpacity
          style={[styles.audioPlayButton, { backgroundColor: theme.colors.primary }]}
          activeOpacity={0.8}
          onPress={handlePlayPause}
        >
          <Ionicons name={isPlaying ? "pause" : "play"} size={20} color="#fff" />
        </TouchableOpacity>
        <View style={styles.audioWaveform}>
          {/* Simple waveform visualization placeholder */}
          {[...Array(16)].map((_, i) => (
            <View
              key={i}
              style={[
                styles.audioBar,
                {
                  height: isPlaying ? WAVEFORM_HEIGHTS[i] : 4,
                  backgroundColor: isMine ? 'rgba(255,255,255,0.5)' : theme.colors.primary
                }
              ]}
            />
          ))}
        </View>
        <Text style={[styles.audioDuration, { color: isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant }]}>
          {formatDuration(metadata?.duration) || '0:00'}
        </Text>
      </View>
    );
  };

  // Open location in maps app
  const openLocation = () => {
    if (!message.location) return;
    const { latitude, longitude } = message.location;
    const label = message.location.address || 'Location';

    const url = Platform.select({
      ios: `maps:0,0?q=${label}@${latitude},${longitude}`,
      android: `geo:0,0?q=${latitude},${longitude}(${label})`,
    });

    if (url) Linking.openURL(url);
  };

  // Check if Maps API key is available (cached at component level to avoid repeated checks)
  const mapsAvailable = hasGoogleMapsApiKey();

  // Location message
  const renderLocationContent = () => {
    if (!message.location) return null;
    const { latitude, longitude } = message.location;

    // Static fallback when Maps API key is not configured
    const renderStaticLocationFallback = () => (
      <View style={[StyleSheet.absoluteFillObject, styles.mapFallback, { backgroundColor: isDark ? 'rgba(30,30,40,0.9)' : 'rgba(240,240,245,0.95)' }]}>
        <Ionicons name="location" size={40} color={theme.colors.primary} />
        <Text style={{ color: theme.colors.onSurface, marginTop: 8, fontSize: 14, fontWeight: '600' }}>Location Shared</Text>
        <Text style={{ color: theme.colors.onSurfaceVariant, marginTop: 4, fontSize: 11, textAlign: 'center', paddingHorizontal: 16 }}>
          Tap to open in Maps
        </Text>
      </View>
    );

    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={openLocation}
        style={styles.locationContainer}
      >
        <View style={styles.locationPreview}>
          {mapsAvailable ? (
            <MapErrorBoundary fallback={renderStaticLocationFallback()}>
              <React.Suspense fallback={
                <View style={[StyleSheet.absoluteFillObject, styles.mapFallback]}>
                  <Ionicons name="location" size={32} color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.onSurfaceVariant, marginTop: 4, fontSize: 12 }}>Loading map...</Text>
                </View>
              }>
                <MapView
                  style={StyleSheet.absoluteFillObject}
                  initialRegion={{
                    latitude,
                    longitude,
                    latitudeDelta: 0.01,
                    longitudeDelta: 0.01,
                  }}
                  scrollEnabled={false}
                  zoomEnabled={false}
                  rotateEnabled={false}
                  pitchEnabled={false}
                  showsPointsOfInterests={false}
                  toolbarEnabled={false}
                  loadingEnabled
                  moveOnMarkerPress={false}
                  liteMode={Platform.OS === 'android'}
                >
                  <Marker
                    coordinate={{
                      latitude,
                      longitude,
                    }}
                    tracksViewChanges={false}
                  />
                </MapView>
              </React.Suspense>
            </MapErrorBoundary>
          ) : (
            renderStaticLocationFallback()
          )}
        </View>
        {message.location.address && (
          <View style={{ padding: 8, backgroundColor: isMine ? 'transparent' : (isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.5)') }}>
            <Text
              numberOfLines={2}
              style={[styles.locationAddress, { color: isMine ? '#fff' : theme.colors.onSurface }]}
            >
              {message.location.address}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Full screen image viewer
  const renderFullScreenImage = () => (
    <Modal
      visible={fullScreenVisible}
      transparent
      animationType="fade"
      onRequestClose={() => setFullScreenVisible(false)}
    >
      <View style={styles.fullScreenContainer}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setFullScreenVisible(false)}>
          <View style={styles.fullScreenBackdrop} />
        </Pressable>
        <Image
          source={{ uri: mediaUri }}
          style={styles.fullScreenImage}
          resizeMode="contain"
        />
        <TouchableOpacity
          style={styles.fullScreenClose}
          onPress={() => setFullScreenVisible(false)}
        >
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
      </View>
    </Modal>
  );

  // Render media based on type
  const renderMedia = () => {
    switch (message.type) {
      case 'image':
        return renderImageContent();
      case 'video':
        return renderVideoContent();
      case 'file':
        return renderDocumentContent();
      case 'audio':
        return renderAudioContent();
      case 'location':
        return renderLocationContent();
      default:
        // For text or unknown, render old image style if local path or mediaUrl exists
        if (mediaUri) {
          return renderImageContent();
        }
        return null;
    }
  };

  // Check if message has text content to display
  const hasTextContent = message.content &&
    !message.content.startsWith('📷') &&
    !message.content.startsWith('🎥') &&
    !message.content.startsWith('🎵') &&
    !message.content.startsWith('📄') &&
    !message.content.startsWith('📍') &&
    !message.content.startsWith('📎');

  const highlightBg = highlightAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', 'rgba(255, 220, 50, 0.35)'],
  });

  const isStarredByMe = !!user && !!message.starredBy?.includes(user.userId);
  const dimStyle = dimmed ? { opacity: 0.35 } : undefined;
  const isMentioned = !!user && !!message.mentions?.includes(user.userId);

  // Track tap timestamps for double-tap detection without needing a gesture-handler graph rewrite.
  const lastTapRef = useRef<number>(0);
  const handlePress = () => {
    if (selectionMode) {
      onToggleSelect?.(message);
      return;
    }
    const now = Date.now();
    if (onDoubleTap && now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTapRef.current = now;
  };

  const renderRichText = (color: string, mineLink?: boolean) => {
    if (!hasTextContent) return null;
    const spans = tokenizeContent(message.content, mentionLabels, searchQuery);
    return (
      <Text style={[styles.text, { color }]}>
        {spans.map((span, i) => {
          if (span.kind === 'mention') {
            return (
              <Text
                key={i}
                onPress={() => onMentionPress?.(span.userId)}
                style={{
                  color: mineLink ? '#ffffff' : theme.colors.primary,
                  fontWeight: '600',
                  textDecorationLine: 'underline',
                }}
              >
                {span.text}
              </Text>
            );
          }
          if (span.kind === 'link') {
            return (
              <Text
                key={i}
                onPress={() => Linking.openURL(span.url).catch(() => undefined)}
                style={{
                  color: mineLink ? '#ffffff' : theme.colors.primary,
                  textDecorationLine: 'underline',
                }}
              >
                {span.text}
              </Text>
            );
          }
          if (span.kind === 'highlight') {
            return (
              <Text
                key={i}
                style={{
                  backgroundColor: 'rgba(255, 213, 79, 0.55)',
                  color: theme.colors.onSurface,
                  fontWeight: '600',
                }}
              >
                {span.text}
              </Text>
            );
          }
          return <Text key={i}>{span.text}</Text>;
        })}
      </Text>
    );
  };

  const renderForwardedTag = () => {
    if (!message.forwardedFrom) return null;
    const manyTimes = message.forwardedFrom.hopCount >= 4;
    return (
      <View style={styles.forwardedRow}>
        <Ionicons
          name={manyTimes ? 'arrow-redo' : 'arrow-redo-outline'}
          size={11}
          color={isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant}
        />
        <Text
          style={[
            styles.forwardedText,
            { color: isMine ? 'rgba(255,255,255,0.75)' : theme.colors.onSurfaceVariant },
          ]}
        >
          {manyTimes ? 'Forwarded many times' : 'Forwarded'}
        </Text>
      </View>
    );
  };

  const handleLongPress = () => {
    if (selectionMode) {
      onToggleSelect?.(message);
      return;
    }
    onLongPress?.(message);
  };
  const handleReactionsPress = () => onReactionsPress?.(message);

  const renderSelectionMarker = (align: 'left' | 'right') => {
    if (!selectionMode) return null;
    const color = selected ? theme.colors.primary : (isDark ? '#666' : '#bbb');
    return (
      <View style={[styles.selectionMarker, align === 'right' ? styles.selectionMarkerRight : styles.selectionMarkerLeft]}>
        <View style={[styles.selectionTick, { borderColor: color, backgroundColor: selected ? color : 'transparent' }]}>
          {selected && <Ionicons name="checkmark" size={12} color="#fff" />}
        </View>
      </View>
    );
  };

  // My message (right side)
  if (isMine) {
    return (
      <>
        <Animated.View
          style={[
            { backgroundColor: highlightBg, borderRadius: 16 },
            isMentioned && { backgroundColor: 'rgba(255, 193, 7, 0.18)' },
            selected && { backgroundColor: isDark ? 'rgba(53,198,255,0.15)' : 'rgba(31,111,235,0.10)' },
            dimStyle,
          ]}
        >
          <Swipeable
            ref={swipeableRef}
            enabled={!selectionMode}
            renderLeftActions={onSwipeReply ? renderLeftActions : undefined}
            renderRightActions={isGroupChat && onSwipeInfo ? renderRightActions : undefined}
            onSwipeableOpen={onSwipeableOpen}
            friction={2}
            overshootLeft={false}
            overshootRight={false}
          >
            {renderSelectionMarker('right')}
            <Pressable
              onPress={handlePress}
              onLongPress={handleLongPress}
              delayLongPress={280}
              android_ripple={undefined}
              style={({ pressed }) => [
                styles.container,
                styles.mine,
                { backgroundColor: theme.colors.primary },
                pressed && (onLongPress || selectionMode) && { opacity: 0.85 },
              ]}
            >
              {renderForwardedTag()}
              {renderReplyContent()}
              {renderMedia()}
              {livePreview && hasTextContent && (
                <LinkPreview preview={livePreview} isMine />
              )}
              {renderRichText(theme.colors.onPrimary, true)}
              <View style={styles.timestampRow}>
                {isStarredByMe && (
                  <Ionicons
                    name="star"
                    size={11}
                    color="rgba(255,255,255,0.85)"
                    style={{ marginRight: 4 }}
                  />
                )}
                {message.editedAt && (
                  <Text style={[styles.editedTag, { color: 'rgba(255,255,255,0.65)' }]}>edited</Text>
                )}
                <Text style={[styles.timestamp, { color: 'rgba(255,255,255,0.7)' }]}>{formatRelativeTime(message.createdAt)}</Text>
                <MessageStatusIndicator
                  status={message.status}
                  isGroupChat={isGroupChat}
                  totalRecipients={totalRecipients}
                  deliveredCount={message.deliveredTo?.length || 0}
                  readCount={message.readBy?.length || 0}
                />
              </View>
            </Pressable>
          </Swipeable>
          <ReactionsRow
            reactions={message.reactions}
            currentUserId={user?.userId}
            align="right"
            onPress={handleReactionsPress}
          />
        </Animated.View>
        {renderFullScreenImage()}
      </>
    );
  }

  // Other's message (left side with optional avatar)
  return (
    <>
      <Animated.View
        style={[
          { backgroundColor: highlightBg, borderRadius: 16 },
          isMentioned && { backgroundColor: 'rgba(255, 193, 7, 0.18)' },
          selected && { backgroundColor: isDark ? 'rgba(53,198,255,0.15)' : 'rgba(31,111,235,0.10)' },
          dimStyle,
        ]}
      >
        <Swipeable
          ref={swipeableRef}
          enabled={!selectionMode}
          renderLeftActions={onSwipeReply ? renderLeftActions : undefined}
          onSwipeableOpen={onSwipeableOpen}
          friction={2}
          overshootLeft={false}
          overshootRight={false}
        >
          <View style={styles.otherRow}>
            {renderSelectionMarker('left')}
            {showSenderInfo !== undefined && (
              <View style={styles.avatarContainer}>
                {showSenderInfo && (
                  <Avatar.Text
                    size={28}
                    label={initials}
                    style={{ backgroundColor: senderColor }}
                    color="#FFF"
                    labelStyle={{ fontSize: 12, lineHeight: 28 }}
                  />
                )}
              </View>
            )}
            <Pressable
              onPress={handlePress}
              onLongPress={handleLongPress}
              delayLongPress={280}
              style={({ pressed }) => [
                styles.container,
                styles.other,
                { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.7)' },
                pressed && (onLongPress || selectionMode) && { opacity: 0.85 },
              ]}
            >
              {renderForwardedTag()}
              {renderReplyContent()}
              {showSenderInfo && senderName && (
                <Text style={[styles.senderName, { color: senderColor }]}>{senderName}</Text>
              )}
              {renderMedia()}
              {livePreview && hasTextContent && (
                <LinkPreview preview={livePreview} isMine={false} />
              )}
              {renderRichText(theme.colors.onSurface)}
              <View style={styles.timestampRow}>
                {isStarredByMe && (
                  <Ionicons
                    name="star"
                    size={11}
                    color={theme.colors.onSurfaceVariant}
                    style={{ marginRight: 4 }}
                  />
                )}
                {message.editedAt && (
                  <Text style={[styles.editedTag, { color: theme.colors.onSurfaceVariant }]}>edited</Text>
                )}
                <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>{formatRelativeTime(message.createdAt)}</Text>
              </View>
            </Pressable>
          </View>
        </Swipeable>
        <ReactionsRow
          reactions={message.reactions}
          currentUserId={user?.userId}
          align="left"
          onPress={handleReactionsPress}
        />
      </Animated.View>
      {renderFullScreenImage()}
    </>
  );
};

const styles = StyleSheet.create({
  systemContainer: {
    alignItems: 'center',
    marginVertical: 12,
    width: '100%',
  },
  systemBubble: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  tombstoneBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  systemText: {
    fontSize: 12,
    textAlign: 'center',
  },
  forwardedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginBottom: 4,
  },
  forwardedText: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  editedTag: {
    fontSize: 10,
    fontStyle: 'italic',
    marginRight: 4,
  },
  selectionMarker: {
    position: 'absolute',
    top: '50%',
    transform: [{ translateY: -10 }],
    zIndex: 5,
  },
  selectionMarkerLeft: {
    left: -22,
  },
  selectionMarkerRight: {
    right: -22,
  },
  selectionTick: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otherRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 8,
    maxWidth: '85%',
  },
  avatarContainer: {
    width: 28,
    marginRight: 8,
  },
  container: {
    padding: 12,
    borderRadius: 16,
  },
  mine: {
    maxWidth: '80%',
    marginLeft: 'auto',
    borderBottomRightRadius: 2,
    marginBottom: 8,
  },
  other: {
    flex: 1,
    borderBottomLeftRadius: 2,
  },
  senderName: {
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  text: {
    // color handled dynamically
  },
  timestamp: {
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  timestampRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
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
  image: {
    marginTop: 8,
    width: 160,
    height: 160,
    borderRadius: 12,
  },
  replyActionContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 50,
  },
  infoActionContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 50,
  },
  replyContainer: {
    borderLeftWidth: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginBottom: 8,
  },
  replySender: {
    fontWeight: 'bold',
    fontSize: 12,
    marginBottom: 2,
  },
  replyText: {
    fontSize: 12,
    flex: 1,
  },
  replyContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Media styles
  mediaContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 4,
  },
  mediaImage: {
    borderRadius: 12,
  },
  mediaVideo: {
    borderRadius: 12,
  },
  imagePlaceholder: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.1)',
    borderRadius: 12,
  },
  downloadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.2)',
    minHeight: 150,
  },
  downloadingText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    marginTop: 8,
  },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  resolutionBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  resolutionText: {
    color: '#fff',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  videoDuration: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  videoDurationText: {
    color: '#fff',
    fontSize: 11,
    marginLeft: 3,
  },
  // Document styles
  documentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 4,
  },
  documentIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  documentInfo: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  documentName: {
    fontSize: 14,
    fontWeight: '500',
  },
  documentSize: {
    fontSize: 11,
    marginTop: 2,
  },
  // Audio styles
  audioContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 50,
    marginBottom: 0,
  },
  audioPlayButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioWaveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
    marginRight: 100,
    height: 24,
    gap: 4,
  },
  audioBar: {
    width: 3,
    borderRadius: 2,
  },
  audioDuration: {
    fontSize: 12,
    minWidth: 35,
    textAlign: 'right',
  },
  // Location styles
  locationContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 4,
  },
  locationPreview: {
    width: 200,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  locationAddress: {
    fontSize: 13,
    padding: 8,
  },
  mapFallback: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  // Full screen image styles
  fullScreenContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullScreenBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  fullScreenImage: {
    width: SCREEN_WIDTH,
    height: '80%',
  },
  fullScreenClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
