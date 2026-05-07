import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import QuickLookPreviewView from '../../../modules/my-module/src/QuickLookPreviewView';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Dimensions,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    StyleSheet,
    TouchableOpacity,
    View
} from 'react-native';
import { ActivityIndicator, IconButton, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SelectedMedia } from './AttachmentMenu';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export type QualityLevel = 'HD' | 'SD';

interface MediaPreviewProps {
  media: SelectedMedia | null;
  visible: boolean;
  onClose: () => void;
  onSend: (caption: string, quality: QualityLevel) => void;
  onPreviewReady?: () => void;
}

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

const formatSeconds = (seconds: number): string => {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Get icon for document type
const getDocumentIcon = (mimeType?: string): keyof typeof Ionicons.glyphMap => {
  if (!mimeType) return 'document';
  if (mimeType.startsWith('application/pdf')) return 'document-text';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'grid';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'easel';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document-text';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return 'archive';
  return 'document';
};

export const MediaPreview = ({ media, visible, onClose, onSend, onPreviewReady }: MediaPreviewProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState('');
  const [quality, setQuality] = useState<QualityLevel>('HD');
  const [videoError, setVideoError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const readyNotifiedRef = useRef(false);

  // Audio player — source is set only when visible and media is audio
  const audioSource = (visible && media?.type === 'audio') ? (media.uri ?? null) : null;
  const audioPlayer = useAudioPlayer(audioSource, { updateInterval: 250 });
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const progressFraction = audioStatus.duration > 0 ? audioStatus.currentTime / audioStatus.duration : 0;

  // Create video player for video media
  const videoSource = media?.type === 'video' ? media.uri : null;
  const player = useVideoPlayer(videoSource, (player) => {
    player.loop = false;
  });

  const markPreviewReady = useCallback(() => {
    setPreviewReady(true);

    if (readyNotifiedRef.current) {
      return;
    }

    readyNotifiedRef.current = true;
    onPreviewReady?.();
  }, [onPreviewReady]);

  useEffect(() => {
    readyNotifiedRef.current = false;
    setVideoError(false);

    if (!visible || !media) {
      setPreviewReady(false);
      return;
    }

    if (media.type !== 'video') {
      const frame = requestAnimationFrame(() => {
        markPreviewReady();
      });

      return () => cancelAnimationFrame(frame);
    }

    setPreviewReady(false);
  }, [markPreviewReady, media, visible]);

  // Handle player status changes
  useEffect(() => {
    if (!player || !visible || media?.type !== 'video') return;

    const subscription = player.addListener('statusChange', (status) => {
      if (status.error) {
        console.log('Video preview error:', status.error);
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
    if (!visible || !media || media.type !== 'video' || previewReady || videoError) {
      return;
    }

    // Some videos never emit a ready event reliably. Fall back to the
    // metadata card so the user can still review and send the attachment.
    const timeout = setTimeout(() => {
      setVideoError(true);
      markPreviewReady();
    }, 5000);

    return () => clearTimeout(timeout);
  }, [markPreviewReady, media, previewReady, videoError, visible]);

  const handleSend = () => {
    if (!previewReady && media?.type === 'video' && !videoError) {
      return;
    }
    if (audioStatus.playing) audioPlayer.pause();
    const captionToSend = caption;
    setCaption('');
    onSend(captionToSend, quality);
  };

  const handleClose = () => {
    setCaption('');
    setVideoError(false);
    setPreviewReady(false);
    if (audioStatus.playing) audioPlayer.pause();
    onClose();
  };

  const toggleAudio = useCallback(async () => {
    try {
      await setAudioModeAsync({ playsInSilentMode: true });
      if (audioStatus.playing) {
        audioPlayer.pause();
      } else {
        audioPlayer.play();
      }
    } catch (err) {
      console.error('Audio toggle error:', err);
    }
  }, [audioPlayer, audioStatus.playing]);

  useEffect(() => {
    if (audioStatus.didJustFinish) {
      audioPlayer.seekTo(0).catch(() => {});
    }
  }, [audioStatus.didJustFinish, audioPlayer]);

  if (!visible || !media) return null;

  const renderMediaContent = () => {
    switch (media.type) {
      case 'image':
      case 'camera':
        return (
          <Image
            source={{ uri: media.uri }}
            style={styles.imagePreview}
            resizeMode="contain"
          />
        );

      case 'video':
        if (videoError) {
          // Show fallback if video fails to load
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
            <VideoView
              player={player}
              style={styles.videoPreview}
              contentFit="contain"
              nativeControls
            />
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
              <Ionicons
                name={getDocumentIcon(media.mimeType)}
                size={80}
                color={theme.colors.primary}
              />
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
          <IconButton
            icon="close"
            iconColor="#fff"
            size={28}
            onPress={handleClose}
          />
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>
              {media.type === 'image' || media.type === 'camera' ? 'Photo' : 
               media.type === 'video' ? 'Video' : 
               media.type === 'document' ? 'Document' :
               media.type === 'audio' ? 'Audio' : 'Media'}
            </Text>
            {(media.type === 'image' || media.type === 'video' || media.type === 'camera') && media.width && media.height && (
              <Text style={styles.headerSubtitle}>
                {media.width} × {media.height}
                {media.duration ? ` • ${formatDuration(media.duration)}` : ''}
              </Text>
            )}
          </View>
          
          {/* Quality Toggle */}
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
                <Text style={[styles.qualityText, quality === 'HD' && styles.qualityTextActive]}>
                  {quality}
                </Text>
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

        {/* Caption Input & Send */}
        <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
          {showCaptionInput && (
            <TextInput
              mode="flat"
              placeholder="Add a caption..."
              placeholderTextColor="rgba(255,255,255,0.5)"
              value={caption}
              onChangeText={setCaption}
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
              <Ionicons name="send" size={24} color="#fff" />
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
  documentTapHint: {
    fontSize: 12,
    marginTop: 12,
    color: 'rgba(255,255,255,0.45)',
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
  audioInfo: {
    flexDirection: 'row',
    alignItems: 'center',
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
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
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
