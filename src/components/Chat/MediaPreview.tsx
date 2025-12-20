import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
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
import { IconButton, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SelectedMedia } from './AttachmentMenu';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export type QualityLevel = 'HD' | 'SD';

interface MediaPreviewProps {
  media: SelectedMedia | null;
  visible: boolean;
  onClose: () => void;
  onSend: (caption: string, quality: QualityLevel) => void;
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

export const MediaPreview = ({ media, visible, onClose, onSend }: MediaPreviewProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [caption, setCaption] = useState('');
  const [quality, setQuality] = useState<QualityLevel>('HD');
  const [videoError, setVideoError] = useState(false);

  // Create video player for video media
  const videoSource = media?.type === 'video' ? media.uri : undefined;
  const player = useVideoPlayer(videoSource, (player) => {
    player.loop = false;
  });

  // Handle player status changes
  useEffect(() => {
    if (!player) return;
    const subscription = player.addListener('statusChange', (status) => {
      if (status.error) {
        console.log('Video preview error:', status.error);
        setVideoError(true);
      }
    });
    return () => subscription.remove();
  }, [player]);

  const handleSend = () => {
    const captionToSend = caption;
    setCaption('');
    onSend(captionToSend, quality);
  };

  const handleClose = () => {
    setCaption('');
    setVideoError(false);
    onClose();
  };

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
              <Text style={styles.documentSize}>
                {formatFileSize(media.fileSize)}
              </Text>
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
            <View style={styles.audioInfo}>
              {media.duration && (
                <Text style={styles.documentSize}>
                  {formatDuration(media.duration)}
                </Text>
              )}
              {media.fileSize && (
                <Text style={styles.documentSize}>
                  {media.duration ? ' • ' : ''}{formatFileSize(media.fileSize)}
                </Text>
              )}
            </View>
          </View>
        );

      default:
        return null;
    }
  };

  const showCaptionInput = media.type === 'image' || media.type === 'video' || media.type === 'camera';
  const showQualityControl = media.type === 'image' || media.type === 'video' || media.type === 'camera';

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
                style={[styles.qualityButton, quality === 'HD' && styles.qualityButtonActive]}
                onPress={() => setQuality(quality === 'HD' ? 'SD' : 'HD')}
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
            style={[styles.sendButton, { backgroundColor: theme.colors.primary }]}
            onPress={handleSend}
            activeOpacity={0.8}
          >
            <Ionicons name="send" size={24} color="#fff" />
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
  videoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
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
  audioInfo: {
    flexDirection: 'row',
    alignItems: 'center',
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
});

export default MediaPreview;
