import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import QuickLookPreviewView from '../../../modules/my-module/src/QuickLookPreviewView';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Dimensions,
    FlatList,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    StyleSheet,
    TouchableOpacity,
    View,
} from 'react-native';
import { ActivityIndicator, IconButton, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SelectedMedia } from './AttachmentMenu';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export type QualityLevel = 'HD' | 'SD';

export interface MediaPreviewSendItem {
  media: SelectedMedia;
  caption: string;
}

interface MediaPreviewProps {
  /** Items in pick order. Empty when the preview is closed. */
  items: SelectedMedia[];
  visible: boolean;
  onClose: () => void;
  /** Fires once when the user taps Send — receives all items with their per-item captions. */
  onSend: (results: MediaPreviewSendItem[], quality: QualityLevel) => void;
  onPreviewReady?: () => void;
}

const STRIP_THUMB_SIZE = 56;
const STRIP_THUMB_GAP = 6;

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDuration = (ms?: number): string => {
  if (!ms) return '';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const formatSeconds = (seconds: number): string => {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const getDocumentIcon = (mimeType?: string): keyof typeof Ionicons.glyphMap => {
  if (!mimeType) return 'document';
  if (mimeType.startsWith('application/pdf')) return 'document-text';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'grid';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'easel';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document-text';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return 'archive';
  return 'document';
};

interface StripThumbProps {
  item: SelectedMedia;
  active: boolean;
  onPress: () => void;
  onRemove: () => void;
  showRemove: boolean;
  primaryColor: string;
}

const StripThumb = ({ item, active, onPress, onRemove, showRemove, primaryColor }: StripThumbProps) => {
  const isVideo = item.type === 'video';
  const isImage = item.type === 'image' || item.type === 'camera';
  return (
    <View style={styles.stripCell}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        style={[
          styles.stripThumb,
          {
            borderColor: active ? primaryColor : 'rgba(255,255,255,0.18)',
            borderWidth: active ? 2 : StyleSheet.hairlineWidth,
          },
        ]}
      >
        {isImage || isVideo ? (
          <Image source={{ uri: item.uri }} style={styles.stripThumbImage} resizeMode="cover" fadeDuration={0} />
        ) : (
          <View style={styles.stripThumbFallback}>
            <Ionicons
              name={item.type === 'audio' ? 'musical-notes' : getDocumentIcon(item.mimeType)}
              size={18}
              color="#aaa"
            />
          </View>
        )}
        {isVideo && (
          <View style={styles.stripVideoBadge}>
            <Ionicons name="play" size={10} color="#fff" />
          </View>
        )}
      </TouchableOpacity>
      {showRemove && (
        <TouchableOpacity style={styles.stripRemove} onPress={onRemove} hitSlop={6}>
          <Ionicons name="close" size={12} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
};

export const MediaPreview = ({ items, visible, onClose, onSend, onPreviewReady }: MediaPreviewProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [activeIndex, setActiveIndex] = useState(0);
  const [captions, setCaptions] = useState<string[]>([]);
  const [quality, setQuality] = useState<QualityLevel>('HD');
  const [videoError, setVideoError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const readyNotifiedRef = useRef(false);
  const stripRef = useRef<FlatList<SelectedMedia>>(null);

  // Keep an internal copy of items so the user can remove individual entries
  // (via the strip's X button) without forcing the parent to manage that state.
  const [internalItems, setInternalItems] = useState<SelectedMedia[]>([]);

  // Reset internal state whenever a NEW batch is opened. Identity-compare on
  // length + first uri keeps the reset cheap and avoids wiping captions on
  // unrelated re-renders.
  const itemsKey = items.length > 0 ? `${items.length}:${items[0].uri}` : '';
  useEffect(() => {
    if (!visible) return;
    setInternalItems(items);
    setCaptions(items.map(() => ''));
    setActiveIndex(0);
    setQuality('HD');
    setVideoError(false);
    setPreviewReady(false);
    readyNotifiedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, itemsKey]);

  const safeIndex = Math.min(activeIndex, Math.max(0, internalItems.length - 1));
  const media = internalItems[safeIndex];

  // Audio player — source only when the active item is audio.
  const audioSource = (visible && media?.type === 'audio') ? (media.uri ?? null) : null;
  const audioPlayer = useAudioPlayer(audioSource, { updateInterval: 250 });
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const progressFraction = audioStatus.duration > 0 ? audioStatus.currentTime / audioStatus.duration : 0;

  // Video player — source only when the active item is a video.
  const videoSource = media?.type === 'video' ? media.uri : null;
  const player = useVideoPlayer(videoSource, (p) => {
    p.loop = false;
  });

  const markPreviewReady = useCallback(() => {
    setPreviewReady(true);
    if (readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    onPreviewReady?.();
  }, [onPreviewReady]);

  // Reset preview-ready state whenever the active item changes so the loading
  // overlay shows for each new video instead of leaking from the previous one.
  useEffect(() => {
    setVideoError(false);
    setPreviewReady(false);
    readyNotifiedRef.current = false;

    if (!visible || !media) return;

    if (media.type !== 'video') {
      const frame = requestAnimationFrame(() => markPreviewReady());
      return () => cancelAnimationFrame(frame);
    }
  }, [markPreviewReady, media, visible, safeIndex]);

  useEffect(() => {
    if (!player || !visible || media?.type !== 'video') return;
    const subscription = player.addListener('statusChange', (status) => {
      if (status.error) {
        setVideoError(true);
        markPreviewReady();
      }
      if (status.status === 'readyToPlay') {
        markPreviewReady();
      }
    });
    return () => subscription.remove();
  }, [markPreviewReady, media?.type, player, visible]);

  useEffect(() => {
    if (!visible || !media || media.type !== 'video' || previewReady || videoError) return;
    const timeout = setTimeout(() => {
      setVideoError(true);
      markPreviewReady();
    }, 5000);
    return () => clearTimeout(timeout);
  }, [markPreviewReady, media, previewReady, videoError, visible]);

  // Keep the active thumb in view inside the strip when navigating.
  useEffect(() => {
    if (!visible || internalItems.length <= 1) return;
    stripRef.current?.scrollToIndex({
      index: Math.min(safeIndex, internalItems.length - 1),
      viewPosition: 0.5,
      animated: true,
    });
  }, [safeIndex, visible, internalItems.length]);

  const handleSend = () => {
    if (internalItems.length === 0) return;
    if (!previewReady && media?.type === 'video' && !videoError) return;
    if (audioStatus.playing) audioPlayer.pause();
    const results: MediaPreviewSendItem[] = internalItems.map((m, i) => ({
      media: m,
      caption: captions[i] ?? '',
    }));
    setCaptions(internalItems.map(() => ''));
    onSend(results, quality);
  };

  const handleClose = () => {
    setCaptions([]);
    setVideoError(false);
    setPreviewReady(false);
    if (audioStatus.playing) audioPlayer.pause();
    onClose();
  };

  const handleRemoveAt = (idx: number) => {
    setInternalItems((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        // Closing in a microtask so state writes settle first.
        setTimeout(() => handleClose(), 0);
      }
      return next;
    });
    setCaptions((prev) => prev.filter((_, i) => i !== idx));
    setActiveIndex((prev) => {
      if (idx < prev) return prev - 1;
      if (idx === prev) return Math.max(0, prev - (prev > 0 ? 1 : 0));
      return prev;
    });
  };

  const toggleAudio = useCallback(async () => {
    try {
      await setAudioModeAsync({ playsInSilentMode: true });
      if (audioStatus.playing) audioPlayer.pause();
      else audioPlayer.play();
    } catch (err) {
      console.error('Audio toggle error:', err);
    }
  }, [audioPlayer, audioStatus.playing]);

  useEffect(() => {
    if (audioStatus.didJustFinish) {
      audioPlayer.seekTo(0).catch(() => {});
    }
  }, [audioStatus.didJustFinish, audioPlayer]);

  const updateActiveCaption = (next: string) => {
    setCaptions((prev) => {
      const out = prev.length === internalItems.length ? [...prev] : internalItems.map((_, i) => prev[i] ?? '');
      out[safeIndex] = next;
      return out;
    });
  };

  const activeCaption = captions[safeIndex] ?? '';

  const headerLabel = useMemo(() => {
    if (!media) return 'Media';
    switch (media.type) {
      case 'image':
      case 'camera':
        return 'Photo';
      case 'video':
        return 'Video';
      case 'document':
        return 'Document';
      case 'audio':
        return 'Audio';
      default:
        return 'Media';
    }
  }, [media]);

  if (!visible || internalItems.length === 0 || !media) return null;

  const renderMediaContent = () => {
    switch (media.type) {
      case 'image':
      case 'camera':
        return (
          <Image
            source={{ uri: media.uri }}
            style={styles.imagePreview}
            resizeMode="contain"
            fadeDuration={0}
            progressiveRenderingEnabled
          />
        );

      case 'video':
        if (videoError) {
          return (
            <View style={styles.videoFallback}>
              <Ionicons name="videocam" size={80} color={theme.colors.primary} />
              <Text style={{ color: '#fff', marginTop: 16 }}>Video selected</Text>
              <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 }}>
                {media.fileName || 'video.mp4'}
              </Text>
              {media.fileSize && (
                <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 }}>
                  {formatFileSize(media.fileSize)}
                </Text>
              )}
            </View>
          );
        }
        return (
          <View style={styles.videoContainer}>
            <VideoView player={player} style={styles.videoPreview} contentFit="contain" nativeControls />
          </View>
        );

      case 'document':
        if (Platform.OS === 'ios') {
          return (
            <QuickLookPreviewView
              url={media.uri}
              onLoad={() => {}}
              style={styles.documentEmbedView}
            />
          );
        }
        return (
          <View style={styles.documentPreview}>
            <View style={[styles.documentIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]}>
              <Ionicons name={getDocumentIcon(media.mimeType)} size={80} color={theme.colors.primary} />
            </View>
            <Text style={[styles.documentName, { color: '#fff' }]} numberOfLines={2}>
              {media.fileName || 'Document'}
            </Text>
            {media.fileSize && (
              <Text style={styles.documentSize}>{formatFileSize(media.fileSize)}</Text>
            )}
          </View>
        );

      case 'audio':
        return (
          <View style={styles.audioPreview}>
            <View style={[styles.audioIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]}>
              <Ionicons name="musical-notes" size={80} color={theme.colors.primary} />
            </View>
            <Text style={[styles.documentName, { color: '#fff' }]} numberOfLines={2}>
              {media.fileName || 'Audio'}
            </Text>
            <View style={styles.audioProgressContainer}>
              <View style={[styles.audioProgressTrack, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: theme.colors.primary,
                    width: `${Math.min(progressFraction * 100, 100)}%`,
                  }}
                />
              </View>
              <View style={styles.audioTimeRow}>
                <Text style={styles.audioTimeText}>{formatSeconds(audioStatus.currentTime)}</Text>
                <Text style={styles.audioTimeText}>{formatSeconds(audioStatus.duration)}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[styles.audioPlayButton, { backgroundColor: theme.colors.primary }]}
              onPress={toggleAudio}
              activeOpacity={0.8}
            >
              <Ionicons name={audioStatus.playing ? 'pause' : 'play'} size={32} color="#fff" />
            </TouchableOpacity>
          </View>
        );

      default:
        return null;
    }
  };

  const showCaptionInput = media.type === 'image' || media.type === 'video' || media.type === 'camera';
  const showQualityControl = media.type === 'image' || media.type === 'video' || media.type === 'camera';
  const isPreviewLoading = media.type === 'video' && !previewReady && !videoError;
  const showStrip = internalItems.length > 1;
  const sendCount = internalItems.length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          {/* Header */}
          <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
            <IconButton icon="close" iconColor="#fff" size={28} onPress={handleClose} />
            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>
                {showStrip ? `${safeIndex + 1} / ${internalItems.length}` : headerLabel}
              </Text>
              {(media.type === 'image' || media.type === 'video' || media.type === 'camera') && media.width && media.height && (
                <Text style={styles.headerSubtitle}>
                  {media.width} × {media.height}
                  {media.duration ? ` • ${formatDuration(media.duration)}` : ''}
                </Text>
              )}
            </View>

            {showQualityControl && (
              <View style={styles.qualityContainer}>
                <TouchableOpacity
                  style={[
                    styles.qualityButton,
                    quality === 'HD' && styles.qualityButtonActive,
                    isPreviewLoading && styles.qualityButtonDisabled,
                  ]}
                  onPress={isPreviewLoading ? undefined : () => setQuality(quality === 'HD' ? 'SD' : 'HD')}
                  activeOpacity={isPreviewLoading ? 1 : 0.7}
                >
                  <Text style={[styles.qualityText, quality === 'HD' && styles.qualityTextActive]}>{quality}</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={{ width: showQualityControl ? 0 : 48 }} />
          </View>

          {/* Media Content */}
          <View style={styles.mediaContainer}>
            {renderMediaContent()}
            {isPreviewLoading ? (
              <View style={styles.previewLoadingOverlay}>
                <View style={styles.previewLoadingCard}>
                  <ActivityIndicator animating size="large" color={theme.colors.primary} />
                  <Text style={styles.previewLoadingTitle}>Loading video preview…</Text>
                  <Text style={styles.previewLoadingSubtitle}>
                    Large videos can take a moment to prepare.
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          {/* Thumbnail strip — only when multiple items are pending */}
          {showStrip && (
            <View style={styles.stripWrap}>
              <FlatList
                ref={stripRef}
                data={internalItems}
                keyExtractor={(item, idx) => `${idx}:${item.uri}`}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.stripContent}
                getItemLayout={(_, idx) => ({
                  length: STRIP_THUMB_SIZE + STRIP_THUMB_GAP + 8,
                  offset: (STRIP_THUMB_SIZE + STRIP_THUMB_GAP + 8) * idx,
                  index: idx,
                })}
                onScrollToIndexFailed={({ index }) => {
                  stripRef.current?.scrollToOffset({
                    offset: index * (STRIP_THUMB_SIZE + STRIP_THUMB_GAP + 8),
                    animated: false,
                  });
                }}
                renderItem={({ item, index }) => (
                  <StripThumb
                    item={item}
                    active={index === safeIndex}
                    onPress={() => setActiveIndex(index)}
                    onRemove={() => handleRemoveAt(index)}
                    showRemove={internalItems.length > 1}
                    primaryColor={theme.colors.primary}
                  />
                )}
              />
            </View>
          )}

          {/* Caption Input & Send */}
          <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
            {showCaptionInput && (
              <TextInput
                mode="flat"
                placeholder={showStrip ? `Caption for ${safeIndex + 1} / ${internalItems.length}…` : 'Add a caption...'}
                placeholderTextColor="rgba(255,255,255,0.5)"
                value={activeCaption}
                onChangeText={updateActiveCaption}
                style={styles.captionInput}
                contentStyle={styles.captionInputContent}
                underlineColor="transparent"
                activeUnderlineColor="transparent"
                textColor="#fff"
                maxLength={500}
                multiline
                numberOfLines={2}
              />
            )}
            <TouchableOpacity
              style={[
                styles.sendButton,
                { backgroundColor: isPreviewLoading ? 'rgba(255,255,255,0.3)' : theme.colors.primary },
              ]}
              onPress={isPreviewLoading ? undefined : handleSend}
              activeOpacity={isPreviewLoading ? 1 : 0.8}
              accessibilityState={{ disabled: isPreviewLoading, busy: isPreviewLoading }}
            >
              {isPreviewLoading ? (
                <ActivityIndicator animating size="small" color="#fff" />
              ) : (
                <View style={styles.sendButtonContent}>
                  <Ionicons name="send" size={22} color="#fff" />
                  {sendCount > 1 && (
                    <Text style={styles.sendButtonCount}>{sendCount}</Text>
                  )}
                </View>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  headerInfo: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  headerSubtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 2,
  },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imagePreview: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.6,
  },
  videoContainer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPreview: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.6,
  },
  previewLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  previewLoadingCard: {
    minWidth: 240,
    maxWidth: 320,
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.68)',
    alignItems: 'center',
    gap: 10,
  },
  previewLoadingTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  previewLoadingSubtitle: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13,
    textAlign: 'center',
  },
  videoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  documentEmbedView: {
    flex: 1,
    width: SCREEN_WIDTH,
    backgroundColor: '#fff',
  },
  documentPreview: {
    alignItems: 'center',
    padding: 40,
  },
  documentIcon: {
    width: 140,
    height: 140,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  documentName: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  documentSize: {
    fontSize: 14,
    marginTop: 8,
    color: 'rgba(255,255,255,0.6)',
  },
  audioPreview: {
    alignItems: 'center',
    padding: 40,
  },
  audioIcon: {
    width: 140,
    height: 140,
    borderRadius: 70,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  audioProgressContainer: {
    width: '80%',
    marginTop: 20,
    marginBottom: 8,
  },
  audioProgressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  audioTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  audioTimeText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
  },
  audioPlayButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
  },
  // Bottom thumbnail strip (multi-pick batch)
  stripWrap: {
    paddingTop: 10,
    paddingBottom: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  stripContent: {
    paddingHorizontal: 12,
    gap: STRIP_THUMB_GAP,
  },
  stripCell: {
    paddingTop: 8,
    paddingRight: 8,
  },
  stripThumb: {
    width: STRIP_THUMB_SIZE,
    height: STRIP_THUMB_SIZE,
    borderRadius: 8,
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
  stripVideoBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripRemove: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  // Caption + send
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    gap: 12,
  },
  captionInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 24,
    maxHeight: 100,
  },
  captionInputContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sendButton: {
    minWidth: 56,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 4,
  },
  sendButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sendButtonCount: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
    minWidth: 14,
    textAlign: 'center',
  },
  qualityContainer: {
    marginRight: 8,
  },
  qualityButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  qualityButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderColor: '#fff',
  },
  qualityText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  qualityTextActive: {
    color: '#000',
  },
  qualityButtonDisabled: {
    opacity: 0.5,
  },
});

export default MediaPreview;
