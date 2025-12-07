import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage, MessageStatus, MessageType } from '@/models';
import { downloadMedia, mediaExistsLocally } from '@/services/mediaService';
import { formatRelativeTime } from '@/utils/format';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Audio, ResizeMode, Video } from 'expo-av';
import { getContentUriAsync, getInfoAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Dimensions, Image, Linking, Modal, Platform, Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Avatar, IconButton, Text } from 'react-native-paper';

interface MessageBubbleProps {
  message: ChatMessage;
  showSenderInfo?: boolean;
  senderName?: string;
  onSwipeReply?: (message: ChatMessage) => void;
  isGroupChat?: boolean;
  totalRecipients?: number;
}

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D'
];

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

// Static waveform pattern for audio visualization
const AUDIO_WAVEFORM_PATTERN = [8, 12, 6, 14, 10, 16, 8, 12, 10, 14, 6, 12, 8, 14, 10, 12];

// WhatsApp-style message status indicator component
const MessageStatusIndicator = ({ status, isGroupChat, totalRecipients, deliveredCount, readCount }: {
  status: MessageStatus;
  isGroupChat?: boolean;
  totalRecipients?: number;
  deliveredCount?: number;
  readCount?: number;
}) => {
  // For group chats, we check if all recipients have delivered/read
  const allDelivered = isGroupChat && totalRecipients ? (deliveredCount || 0) >= totalRecipients : status === 'delivered' || status === 'read';
  const allRead = isGroupChat && totalRecipients ? (readCount || 0) >= totalRecipients : status === 'read';

  const getIconConfig = () => {
    switch (status) {
      case 'sending':
        return { name: 'time-outline' as const, color: 'rgba(255,255,255,0.6)', size: 14 };
      case 'failed':
        return { name: 'alert-circle-outline' as const, color: '#FF6B6B', size: 14 };
      case 'sent':
        return { name: 'checkmark' as const, color: 'rgba(255,255,255,0.7)', size: 14 };
      case 'delivered':
        // In group chat, use grey if not all delivered
        if (isGroupChat && !allDelivered) {
          return { name: 'checkmark' as const, color: 'rgba(255,255,255,0.7)', size: 14 };
        }
        return { name: 'checkmark-done' as const, color: 'rgba(255,255,255,0.7)', size: 14 };
      case 'read':
        // In group chat, show blue only if all have read
        if (isGroupChat && !allRead) {
          return { name: 'checkmark-done' as const, color: 'rgba(255,255,255,0.7)', size: 14 };
        }
        return { name: 'checkmark-done' as const, color: '#53BDEB', size: 14 }; // WhatsApp blue
      default:
        return { name: 'checkmark' as const, color: 'rgba(255,255,255,0.7)', size: 14 };
    }
  };

  const { name, color, size } = getIconConfig();
  return <Ionicons name={name} size={size} color={color} style={{ marginLeft: 4 }} />;
};

export const MessageBubble = ({ message, showSenderInfo, senderName, onSwipeReply, isGroupChat, totalRecipients }: MessageBubbleProps) => {
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [fullScreenVisible, setFullScreenVisible] = useState(false);
  const videoRef = useRef<Video>(null);
  
  // Audio playback state
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Unload sound on unmount
  useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync();
      }
    };
  }, [sound]);

  const handlePlayPause = async () => {
    if (!mediaUri) return;

    try {
      if (sound) {
        if (isPlaying) {
          await sound.pauseAsync();
          setIsPlaying(false);
        } else {
          await sound.playAsync();
          setIsPlaying(true);
        }
      } else {
        // Configure audio session for playback
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });

        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: mediaUri },
          { shouldPlay: true },
          (status) => {
            if (status.isLoaded) {
              setIsPlaying(status.isPlaying);
              if (status.didJustFinish) {
                setIsPlaying(false);
                newSound.setPositionAsync(0);
              }
            }
          }
        );
        setSound(newSound);
        setIsPlaying(true);
      }
    } catch (error) {
      console.error('Error playing audio:', error);
      Alert.alert('Error', 'Could not play audio message.');
    }
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

  const renderLeftActions = (progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>) => {
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

  const onSwipeableOpen = () => {
    if (onSwipeReply) {
      onSwipeReply(message);
      swipeableRef.current?.close();
    }
  };

  // Reply preview component
  const renderReplyContent = () => {
    if (!message.replyTo) return null;
    const replyColor = getSenderColor(message.replyTo.senderId);
    const isMediaReply = message.replyTo.type && message.replyTo.type !== 'text';

    return (
      <View style={[styles.replyContainer, {
        borderLeftColor: replyColor,
        backgroundColor: isMine ? 'rgba(0,0,0,0.15)' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)')
      }]}>
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
      </View>
    );
  };

  // Get the media URI - prefer local path over remote URL
  // Also handles automatic downloading for received media
  const [mediaUri, setMediaUri] = useState<string | undefined>(
    message.localMediaPath || message.mediaUrl
  );
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

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
  }, [message.id, message.messageId, message.mediaUrl, message.localMediaPath]);

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

    return (
      <TouchableOpacity 
        activeOpacity={0.9}
        onPress={() => setFullScreenVisible(true)}
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
      </TouchableOpacity>
    );
  };

  // Video content with player
  const renderVideoContent = () => {
    if (!mediaUri && !isDownloading) return null;

    // Show sending state
    if (message.status === 'sending' && mediaUri) {
      return (
        <View style={[styles.mediaContainer, imageDimensions]}>
          <Video
            source={{ uri: mediaUri }}
            style={[styles.mediaVideo, imageDimensions]}
            resizeMode={ResizeMode.COVER}
            shouldPlay={false}
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
          <Text style={styles.downloadingText}>Downloading video...</Text>
        </View>
      );
    }

    return (
      <View style={[styles.mediaContainer, imageDimensions]}>
        <Video
          ref={videoRef}
          source={{ uri: mediaUri }}
          style={[styles.mediaVideo, imageDimensions]}
          resizeMode={ResizeMode.COVER}
          useNativeControls
          shouldPlay={false}
          isLooping={false}
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

  // Handle opening/downloading document
  const handleOpenDocument = async () => {
    if (!mediaUri) {
      Alert.alert('File Not Available', 'The file has not been downloaded yet.');
      return;
    }
    
    const mimeType = message.mediaMetadata?.mimeType || 'application/octet-stream';
    const fileName = message.mediaMetadata?.fileName || 'Document';
    
    try {
      // Check if file exists
      const fileInfo = await getInfoAsync(mediaUri);
      if (!fileInfo.exists) {
        Alert.alert('File Not Found', 'The file could not be found on this device.');
        return;
      }

      // Check if sharing is available
      const isAvailable = await Sharing.isAvailableAsync();
      
      if (isAvailable) {
        // Use sharing to open the file with the system's default app
        await Sharing.shareAsync(mediaUri, {
          mimeType,
          dialogTitle: `Open ${fileName}`,
          UTI: mimeType, // iOS specific
        });
      } else if (Platform.OS === 'android') {
        // On Android, try to open with intent
        try {
          const contentUri = await getContentUriAsync(mediaUri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            type: mimeType,
            flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
          });
        } catch (intentError) {
          console.error('Intent error:', intentError);
          Alert.alert(
            'Cannot Open File',
            'No app is available to open this file type.',
            [{ text: 'OK' }]
          );
        }
      } else {
        // Fallback for iOS if sharing isn't available
        const canOpen = await Linking.canOpenURL(mediaUri);
        if (canOpen) {
          await Linking.openURL(mediaUri);
        } else {
          Alert.alert(
            'Cannot Open File',
            'No app is available to open this file type.',
            [{ text: 'OK' }]
          );
        }
      }
    } catch (error) {
      console.error('Error opening document:', error);
      Alert.alert(
        'Cannot Open Document',
        `Unable to open "${fileName}". The file may not be accessible or the format is not supported.`,
        [{ text: 'OK' }]
      );
    }
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
          {/* Static waveform visualization */}
          {AUDIO_WAVEFORM_PATTERN.map((height, i) => (
            <View 
              key={i}
              style={[
                styles.audioBar, 
                { 
                  height: isPlaying ? height : 4,
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

  // Location message
  const renderLocationContent = () => {
    if (!message.location) return null;

    return (
      <View style={styles.locationContainer}>
        <View style={[styles.locationPreview, { backgroundColor: isDark ? '#2a2a2a' : '#f0f0f0' }]}>
          <Ionicons name="location" size={40} color={theme.colors.primary} />
        </View>
        {message.location.address && (
          <Text 
            numberOfLines={2} 
            style={[styles.locationAddress, { color: isMine ? '#fff' : theme.colors.onSurface }]}
          >
            {message.location.address}
          </Text>
        )}
      </View>
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

  // My message (right side)
  if (isMine) {
    return (
      <>
        <Swipeable
          ref={swipeableRef}
          renderLeftActions={onSwipeReply ? renderLeftActions : undefined}
          onSwipeableOpen={onSwipeableOpen}
          friction={2}
          overshootLeft={false}
        >
          <View style={[styles.container, styles.mine, { backgroundColor: theme.colors.primary }]}>
            {renderReplyContent()}
            {renderMedia()}
            {hasTextContent && (
              <Text style={[styles.text, { color: theme.colors.onPrimary }]}>{message.content}</Text>
            )}
            <View style={styles.timestampRow}>
              <Text style={[styles.timestamp, { color: 'rgba(255,255,255,0.7)' }]}>{formatRelativeTime(message.createdAt)}</Text>
              <MessageStatusIndicator
                status={message.status}
                isGroupChat={isGroupChat}
                totalRecipients={totalRecipients}
                deliveredCount={message.deliveredTo?.length || 0}
                readCount={message.readBy?.length || 0}
              />
            </View>
          </View>
        </Swipeable>
        {renderFullScreenImage()}
      </>
    );
  }

  // Other's message (left side with optional avatar)
  return (
    <>
      <Swipeable
        ref={swipeableRef}
        renderLeftActions={onSwipeReply ? renderLeftActions : undefined}
        onSwipeableOpen={onSwipeableOpen}
        friction={2}
        overshootLeft={false}
      >
        <View style={styles.otherRow}>
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
          <View style={[styles.container, styles.other, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.7)' }]}>
            {renderReplyContent()}
            {showSenderInfo && senderName && (
              <Text style={[styles.senderName, { color: senderColor }]}>{senderName}</Text>
            )}
            {renderMedia()}
            {hasTextContent && (
              <Text style={[styles.text, { color: theme.colors.onSurface }]}>{message.content}</Text>
            )}
            <Text style={[styles.timestamp, { color: theme.colors.onSurfaceVariant }]}>{formatRelativeTime(message.createdAt)}</Text>
          </View>
        </View>
      </Swipeable>
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
  systemText: {
    fontSize: 12,
    textAlign: 'center',
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
  },
  locationAddress: {
    fontSize: 13,
    padding: 8,
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
