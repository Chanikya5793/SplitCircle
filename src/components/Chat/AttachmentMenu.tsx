import { usePreventDoubleSubmit } from '@/hooks/usePreventDoubleSubmit';
import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createAudioPlayer, type AudioStatus } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal, Platform, Pressable,
  StyleSheet,
  TouchableOpacity,
  View
} from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  runOnJS
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export type AttachmentType = 'image' | 'video' | 'camera' | 'document' | 'audio' | 'location';

export interface SelectedMedia {
  type: AttachmentType;
  uri: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface AttachmentMenuProps {
  visible: boolean;
  onClose: () => void;
  /** Receives a single selection (camera/document/audio/location) or an ordered batch (gallery photos+videos). */
  onMediaSelected: (media: SelectedMedia | SelectedMedia[]) => void | Promise<void>;
}

interface AttachmentOption {
  id: AttachmentType;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  backgroundColor: string;
}

const extractDurationMillis = (status: AudioStatus): number | undefined => {
  if (!status.isLoaded || !Number.isFinite(status.duration) || status.duration <= 0) {
    return undefined;
  }
  return Math.round(status.duration * 1000);
};

const readAudioDurationMillis = async (uri: string): Promise<number | undefined> => {
  const player = createAudioPlayer(uri, { updateInterval: 200 });

  try {
    const immediateDuration = extractDurationMillis({
      ...player.currentStatus,
      duration: player.duration,
      isLoaded: player.isLoaded,
    });
    if (immediateDuration) {
      return immediateDuration;
    }

    return await new Promise<number | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        player.removeAllListeners('playbackStatusUpdate');
        resolve(undefined);
      }, 2500);

      player.addListener('playbackStatusUpdate', (status) => {
        const duration = extractDurationMillis(status);
        if (!duration) {
          return;
        }
        clearTimeout(timeout);
        player.removeAllListeners('playbackStatusUpdate');
        resolve(duration);
      });
    });
  } finally {
    player.removeAllListeners('playbackStatusUpdate');
    player.remove();
  }
};

const ATTACHMENT_OPTIONS: AttachmentOption[] = [
  {
    id: 'camera',
    icon: 'camera',
    label: 'Camera',
    color: '#FFFFFF',
    backgroundColor: '#E91E63',
  },
  {
    id: 'image',
    icon: 'images',
    label: 'Photos & Videos',
    color: '#FFFFFF',
    backgroundColor: '#9C27B0',
  },
  {
    id: 'document',
    icon: 'document',
    label: 'Document',
    color: '#FFFFFF',
    backgroundColor: '#3F51B5',
  },
  {
    id: 'audio',
    icon: 'musical-notes',
    label: 'Audio',
    color: '#FFFFFF',
    backgroundColor: '#FF9800',
  },
  {
    id: 'location',
    icon: 'location',
    label: 'Location',
    color: '#FFFFFF',
    backgroundColor: '#4CAF50',
  },
];

// Loading messages shown inside the menu after native picker returns
const getProcessingMessage = (type: AttachmentType): string => {
  switch (type) {
    case 'video':
      return 'Preparing video…';
    case 'camera':
      return 'Processing photo…';
    case 'image':
      return 'Loading image…';
    case 'document':
      return 'Loading document…';
    case 'audio':
      return 'Loading audio…';
    case 'location':
      return 'Opening map…';
    default:
      return 'Preparing…';
  }
};

const getSelectionMessage = (type: AttachmentType): string => {
  switch (type) {
    case 'video':
    case 'image':
      return 'Opening media library…';
    case 'camera':
      return 'Opening camera…';
    case 'document':
      return 'Opening files…';
    case 'audio':
      return 'Opening audio files…';
    case 'location':
      return 'Opening map…';
    default:
      return 'Opening attachment…';
  }
};

export const AttachmentMenu = ({ visible, onClose, onMediaSelected }: AttachmentMenuProps) => {
  const { theme, isDark } = useTheme();
  const { loading: selectingAttachment, run: runAttachmentSelection } = usePreventDoubleSubmit();
  const [status, setStatus] = useState<{ type: AttachmentType; message: string } | null>(null);
  const isProcessing = status !== null;

  // Reanimated shared values
  const slideAnim = useSharedValue(300);
  const fadeAnim = useSharedValue(0);
  const context = useSharedValue({ y: 0 });

  // Reset processing state when menu becomes hidden
  useEffect(() => {
    if (!visible) {
      setStatus(null);
    }
  }, [visible]);

  useEffect(() => {
    if (visible) {
      slideAnim.value = withTiming(0, { duration: 300 });
      fadeAnim.value = withTiming(1, { duration: 200 });
    } else {
      slideAnim.value = withTiming(300, { duration: 250 });
      fadeAnim.value = withTiming(0, { duration: 150 });
    }
  }, [visible]);

  // Gesture handler with context for smooth dragging
  const gesture = Gesture.Pan()
    .enabled(!(selectingAttachment || isProcessing))
    .onStart(() => {
      context.value = { y: slideAnim.value };
    })
    .onUpdate((event) => {
      // Allow dragging down (positive translation)
      // Add minimal resistance for dragging up (negative translation)
      const resistance = event.translationY < 0 ? 0.2 : 1;
      const potentialValue = context.value.y + (event.translationY * resistance);
      slideAnim.value = Math.max(-50, potentialValue); // Cap upward drag
    })
    .onEnd((event) => {
      if (slideAnim.value > 100 || event.velocityY > 500) {
        // Dragged down enough or flicked down -> Close
        slideAnim.value = withTiming(300, { duration: 200 }, () => {
          runOnJS(onClose)();
        });
      } else {
        // Spring back to open state
        slideAnim.value = withSpring(0, { damping: 50 });
      }
    });

  const menuSurface = (theme.colors as any).elevation?.level3 ?? theme.colors.surface;
  const menuStyle = useAnimatedStyle(() => ({
    backgroundColor: menuSurface,
    transform: [{ translateY: slideAnim.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: fadeAnim.value,
  }));

  const requestCameraPermission = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Camera Permission Required',
        'Please enable camera access in your device settings to take photos.',
        [{ text: 'OK' }]
      );
      return false;
    }
    return true;
  };

  const requestMediaLibraryPermission = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Photo Library Permission Required',
        'Please enable photo library access in your device settings to select media.',
        [{ text: 'OK' }]
      );
      return false;
    }
    return true;
  };

  const handleCamera = useCallback(async () => {
    const hasPermission = await requestCameraPermission();
    if (!hasPermission) {
      setStatus(null);
      return;
    }

    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.8,
        allowsEditing: false,
        exif: false,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setStatus({ type: 'camera', message: getProcessingMessage('camera') });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        await Promise.resolve(onMediaSelected({
          type: 'camera',
          uri: asset.uri,
          fileName: asset.fileName || `IMG_${Date.now()}.jpg`,
          fileSize: asset.fileSize,
          mimeType: asset.mimeType || 'image/jpeg',
          width: asset.width,
          height: asset.height,
        }));
      } else {
        setStatus(null);
      }
    } catch (error) {
      console.error('Camera error:', error);
      setStatus(null);
      Alert.alert('Camera Error', 'Failed to capture photo. Please try again.');
    }
  }, [onMediaSelected]);

  // Batch picker — photos and videos, mixed order, up to 10 items in one tap.
  // Each item ships as its own message, in pick order.
  const handleGalleryMedia = useCallback(async () => {
    const hasPermission = await requestMediaLibraryPermission();
    if (!hasPermission) {
      setStatus(null);
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        allowsMultipleSelection: true,
        selectionLimit: 10,
        orderedSelection: true,
        allowsEditing: false,
        exif: false,
        videoExportPreset: ImagePicker.VideoExportPreset.MediumQuality,
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
      });

      if (result.canceled || !result.assets?.length) {
        setStatus(null);
        return;
      }

      const assets = result.assets;
      const hasVideo = assets.some((a) => a.type === 'video');
      setStatus({
        type: hasVideo ? 'video' : 'image',
        message:
          assets.length > 1
            ? `Preparing ${assets.length} items…`
            : getProcessingMessage(hasVideo ? 'video' : 'image'),
      });

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      const batch: SelectedMedia[] = assets.map((asset) => {
        const isVideo = asset.type === 'video';
        const stamp = Date.now();
        return isVideo
          ? {
              type: 'video',
              uri: asset.uri,
              fileName: asset.fileName || `VID_${stamp}.mp4`,
              fileSize: asset.fileSize,
              mimeType: asset.mimeType || 'video/mp4',
              width: asset.width,
              height: asset.height,
              duration: asset.duration ?? undefined,
            }
          : {
              type: 'image',
              uri: asset.uri,
              fileName: asset.fileName || `IMG_${stamp}.jpg`,
              fileSize: asset.fileSize,
              mimeType: asset.mimeType || 'image/jpeg',
              width: asset.width,
              height: asset.height,
            };
      });

      await Promise.resolve(onMediaSelected(batch.length === 1 ? batch[0] : batch));
    } catch (error) {
      console.error('Gallery media error:', error);
      setStatus(null);
      Alert.alert('Selection Error', 'Failed to select media. Please try again.');
    }
  }, [onMediaSelected]);

  const handleDocument = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setStatus({ type: 'document', message: getProcessingMessage('document') });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        await Promise.resolve(onMediaSelected({
          type: 'document',
          uri: asset.uri,
          fileName: asset.name,
          fileSize: asset.size,
          mimeType: asset.mimeType || 'application/octet-stream',
        }));
      } else {
        setStatus(null);
      }
    } catch (error) {
      console.error('Document picker error:', error);
      setStatus(null);
      Alert.alert('Selection Error', 'Failed to select document. Please try again.');
    }
  }, [onMediaSelected]);

  const handleAudio = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setStatus({ type: 'audio', message: getProcessingMessage('audio') });
        let duration: number | undefined;

        // Try to get duration
        try {
          duration = await readAudioDurationMillis(asset.uri);
        } catch (e) {
          console.warn('Failed to get audio duration:', e);
        }

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        await Promise.resolve(onMediaSelected({
          type: 'audio',
          uri: asset.uri,
          fileName: asset.name,
          fileSize: asset.size,
          mimeType: asset.mimeType || 'audio/mpeg',
          duration: duration,
        }));
      } else {
        setStatus(null);
      }
    } catch (error) {
      console.error('Audio picker error:', error);
      setStatus(null);
      Alert.alert('Selection Error', 'Failed to select audio. Please try again.');
    }
  }, [onMediaSelected]);

  const handleLocation = useCallback(async () => {
    setStatus({ type: 'location', message: getProcessingMessage('location') });
    await Promise.resolve(onMediaSelected({
      type: 'location',
      uri: '', // No URI needed for initial selection
    }));
  }, [onMediaSelected]);

  const handleOptionPress = useCallback((option: AttachmentOption) => {
    void runAttachmentSelection(async () => {
      setStatus({ type: option.id, message: getSelectionMessage(option.id) });

      switch (option.id) {
        case 'camera':
          await handleCamera();
          break;
        case 'image':
        case 'video':
          await handleGalleryMedia();
          break;
        case 'document':
          await handleDocument();
          break;
        case 'audio':
          await handleAudio();
          break;
        case 'location':
          await handleLocation();
          break;
      }
    }, {
      key: 'chat-attachment-selection',
      // NO global overlay — it renders behind this Modal and is invisible.
      // Instead we show inline feedback inside the sheet itself.
      overlay: false,
    });
  }, [
    handleAudio,
    handleCamera,
    handleDocument,
    handleGalleryMedia,
    handleLocation,
    runAttachmentSelection,
  ]);

  const renderOption = (option: AttachmentOption) => {
    const isDisabled = selectingAttachment || isProcessing;
    return (
      <TouchableOpacity
        key={option.id}
        style={styles.optionContainer}
        onPress={isDisabled ? undefined : () => handleOptionPress(option)}
        activeOpacity={isDisabled ? 1 : 0.7}
      >
        <View style={[
          styles.optionButton,
          { backgroundColor: option.backgroundColor },
          isDisabled && { opacity: 0.4 },
        ]}>
          <Ionicons name={option.icon} size={28} color={option.color} />
        </View>
        <Text style={[styles.optionLabel, { color: theme.colors.onSurface }]}>{option.label}</Text>
      </TouchableOpacity>
    );
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={(selectingAttachment || isProcessing) ? () => undefined : onClose}
    >
      <View style={styles.modalContainer}>
        {/* Backdrop */}
        <Pressable style={StyleSheet.absoluteFill} onPress={(selectingAttachment || isProcessing) ? undefined : onClose}>
          <Animated.View
            style={[
              styles.backdrop,
              backdropStyle,
            ]}
          />
        </Pressable>

        {/* Menu */}
        <GestureDetector gesture={gesture}>
          <Animated.View
            style={[
              styles.menuContainer,
              menuStyle,
            ]}
          >
            {/* Handle */}
            <View style={styles.handleContainer}>
              <View style={[styles.handle, { backgroundColor: theme.colors.outlineVariant ?? (isDark ? '#555' : '#ccc') }]} />
            </View>

            {/* Processing indicator — shown after native picker returns */}
            {isProcessing ? (
              <View style={styles.processingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={[styles.processingText, { color: theme.colors.onSurface }]}>
                  {status?.message ?? 'Preparing…'}
                </Text>
                <Text style={[styles.processingHint, { color: theme.colors.onSurfaceVariant }]}>
                  Please keep this screen open while we prepare your attachment.
                </Text>
              </View>
            ) : (
              <>
                {/* Options Grid */}
                <View style={styles.optionsGrid}>
                  {ATTACHMENT_OPTIONS.map((option) => renderOption(option))}
                </View>

                {/* Cancel Button */}
                <TouchableOpacity
                  style={[
                    styles.cancelButton,
                    { backgroundColor: theme.colors.surfaceVariant ?? (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)') },
                    selectingAttachment && { opacity: 0.5 },
                  ]}
                  onPress={selectingAttachment ? undefined : onClose}
                  activeOpacity={selectingAttachment ? 1 : 0.7}
                >
                  <Text style={[styles.cancelText, { color: theme.colors.error }]}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  menuContainer: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    paddingTop: 12,
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: 'space-around',
  },
  optionContainer: {
    alignItems: 'center',
    width: SCREEN_WIDTH / 3 - 20,
    marginVertical: 12,
  },
  optionButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  optionLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  cancelButton: {
    marginHorizontal: 20,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
  },
  processingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 16,
  },
  processingText: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  processingHint: {
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});

export default AttachmentMenu;
