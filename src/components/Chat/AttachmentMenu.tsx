import { GlassCard } from '@/components/ui';
import { usePreventDoubleSubmit } from '@/hooks/usePreventDoubleSubmit';
import { useTheme } from '@/context/ThemeContext';
import { appAlert } from '@/utils/appAlert';
import {
  isNativeMediaAvailable,
  pickAssets,
  requestThumbnail,
} from '../../../modules/splitcircle-media';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createAudioPlayer, type AudioStatus } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
  /**
   * A file we can read right now.
   *
   * When `assetId` is set this is only a PREVIEW-quality thumbnail — the real
   * bytes still live in the photo library (and possibly only in iCloud), and
   * are fetched at send time. Anything that needs full quality must
   * materialize first rather than using this.
   */
  uri: string;
  /**
   * PHAsset local identifier, when this came from the native picker.
   *
   * Its presence is what says "the original has not been downloaded yet". It
   * is cleared once an item is materialized or edited, because from then on
   * `uri` IS the authoritative file.
   */
  assetId?: string;
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

// Icon/label only — the vivid accent backgrounds are derived from the active
// theme at render time (see `attachmentOptions` below) instead of ignoring the
// user's accent with hardcoded hexes.
const ATTACHMENT_OPTIONS: Pick<AttachmentOption, 'id' | 'icon' | 'label'>[] = [
  { id: 'camera', icon: 'camera', label: 'Camera' },
  { id: 'image', icon: 'images', label: 'Photos & Videos' },
  { id: 'document', icon: 'document', label: 'Document' },
  { id: 'audio', icon: 'musical-notes', label: 'Audio' },
  { id: 'location', icon: 'location', label: 'Location' },
];

/**
 * How long the sheet waits for the parent to accept a selection before
 * dismissing itself anyway. Generous enough that the normal case still shows
 * its progress copy, short enough that a stall never looks like a frozen app.
 */
const HANDOFF_DEADLINE_MS = 4000;

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
  /**
   * Hands the selection to the parent and ALWAYS tears the sheet down.
   *
   * Every handler here used to clear `status` only on cancel or error, never
   * after a successful hand-off — and `status` is otherwise reset only when
   * the menu is re-OPENED. So a successful pick left `isProcessing` stuck
   * true, which disables the pan gesture and keeps the blocking overlay
   * mounted: the picker appeared to vanish while the whole chat stopped
   * responding, recoverable only by navigating away and back. That is the
   * reported freeze, and it happened on the success path, which is why it
   * looked like "nothing is happening".
   *
   * It also no longer depends on the parent to close: if `onMediaSelected`
   * rejects, the parent may never get the chance, and the sheet would sit
   * there swallowing every touch.
   */
  const deliverSelection = async (media: SelectedMedia | SelectedMedia[]) => {
    try {
      // RACED AGAINST A DEADLINE, because `finally` only runs if the promise
      // SETTLES. The parent's handler uploads the file and encrypts it for
      // every recipient device — a network stall or a hung callable there
      // would otherwise keep this sheet mounted forever, and the sheet is
      // what blocks the chat. Losing the race is not an error: the send keeps
      // running and the message bubble carries its own sent/failed state, so
      // the right outcome is to get out of the user's way.
      await Promise.race([
        Promise.resolve(onMediaSelected(media)),
        new Promise((resolve) => setTimeout(resolve, HANDOFF_DEADLINE_MS)),
      ]);
    } finally {
      setStatus(null);
      onClose();
    }
  };

  const { theme, isDark } = useTheme();
  const { loading: selectingAttachment, run: runAttachmentSelection } = usePreventDoubleSubmit();
  const [status, setStatus] = useState<{ type: AttachmentType; message: string } | null>(null);
  const isProcessing = status !== null;

  // Vivid, theme-aware chips. Each option maps to a semantic accent role so the
  // grid follows the user's accent + light/dark scheme instead of fixed hexes.
  const attachmentOptions = useMemo<AttachmentOption[]>(() => {
    const palette: Record<AttachmentType, { color: string; backgroundColor: string }> = {
      camera: { color: theme.colors.onError, backgroundColor: theme.colors.error },
      image: { color: theme.colors.onSecondary, backgroundColor: theme.colors.secondary },
      video: { color: theme.colors.onPrimary, backgroundColor: theme.colors.primary },
      document: { color: theme.colors.onPrimary, backgroundColor: theme.colors.primary },
      audio: { color: theme.colors.onWarning, backgroundColor: theme.colors.warning },
      location: { color: theme.colors.onSuccess, backgroundColor: theme.colors.success },
    };
    return ATTACHMENT_OPTIONS.map((option) => ({ ...option, ...palette[option.id] }));
  }, [theme]);

  // Reanimated shared values
  const slideAnim = useSharedValue(300);
  const fadeAnim = useSharedValue(0);
  const context = useSharedValue({ y: 0 });

  // Reset processing state only when the menu is *re-opened*, not on the
  // visible→false transition. Clearing on hide caused the "Preparing N items…"
  // copy to vanish for a frame while the sheet slid down, which read as a
  // flicker just before the media preview took over.
  useEffect(() => {
    if (visible) {
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

  const menuStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: slideAnim.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: fadeAnim.value,
  }));

  const requestCameraPermission = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      appAlert(
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
      appAlert(
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
        await deliverSelection({
          type: 'camera',
          uri: asset.uri,
          fileName: asset.fileName || `IMG_${Date.now()}.jpg`,
          fileSize: asset.fileSize,
          mimeType: asset.mimeType || 'image/jpeg',
          width: asset.width,
          height: asset.height,
        });
      } else {
        setStatus(null);
      }
    } catch (error) {
      console.error('Camera error:', error);
      setStatus(null);
      appAlert('Camera Error', 'Failed to capture photo. Please try again.');
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
      // Preferred path: pick identifiers only, then render local thumbnails.
      //
      // `launchImageLibraryAsync` materializes every selected asset before it
      // resolves, and its video fast path calls
      // `PHAssetResourceManager.writeData` with no progressHandler and no
      // cancellation. On a library using "Optimize iPhone Storage" that means
      // the app sits frozen for the length of a full iCloud download — minutes
      // for a large video — with no feedback and no way out, and a watchdog
      // kill or memory crash if the file is big enough. Here nothing is
      // downloaded until the user actually sends.
      // A throw here falls THROUGH to the legacy picker rather than failing the
      // whole action. This is a new native module on its first ship: if it
      // misbehaves the user should get the old (slow) picker, not a dead
      // attachment button. A cancelled pick resolves to [] and is not an error.
      let nativePicked: Awaited<ReturnType<typeof pickAssets>> | null = null;
      if (isNativeMediaAvailable()) {
        try {
          nativePicked = await pickAssets(10, 'all');
        } catch (nativeError) {
          console.warn('Native picker failed, falling back to expo-image-picker', nativeError);
          nativePicked = null;
        }
      }

      if (nativePicked) {
        const picked = nativePicked;
        if (picked.length === 0) {
          setStatus(null);
          return;
        }

        setStatus({
          type: picked.some((a) => a.type === 'video') ? 'video' : 'image',
          message:
            picked.length > 1 ? `Preparing ${picked.length} items…` : 'Preparing…',
        });

        const batch: SelectedMedia[] = await Promise.all(
          picked.map(async (asset) => {
            let previewUri = '';
            try {
              previewUri = (await requestThumbnail(asset.assetId, 1280)).uri;
            } catch (error) {
              // A thumbnail failure is not fatal — the item can still be sent,
              // it just shows a placeholder in the preview strip.
              console.warn('Thumbnail failed for', asset.assetId, error);
            }
            return {
              type: asset.type === 'video' ? 'video' : 'image',
              uri: previewUri,
              assetId: asset.assetId,
              fileName: asset.fileName,
              mimeType: asset.type === 'video' ? 'video/quicktime' : 'image/jpeg',
              width: asset.width,
              height: asset.height,
              duration: asset.duration > 0 ? asset.duration : undefined,
            } satisfies SelectedMedia;
          }),
        );

        await deliverSelection(batch.length === 1 ? batch[0] : batch);
        return;
      }

      // Fallback (non-iOS, or a JS bundle running against a binary without the
      // native module). Same behaviour as before, freeze and all.
      //
      // Use `Passthrough` (no re-encode) + `shouldDownloadFromNetwork` so
      // iCloud-only assets get pulled down but we don't pay for a second
      // transcoding pass — our `processVideo` (react-native-compressor) is
      // the single source of compression with per-item HD/SD + progress.
      //
      // Anything heavier than Passthrough makes iOS transcode every video
      // synchronously inside `launchImageLibraryAsync` (measured ~75s of
      // dead time for a 10-item batch with two videos). Anything lighter
      // and iCloud-only videos throw PHPhotosErrorDomain 3164 ("asset not
      // available, network access required").
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        allowsMultipleSelection: true,
        selectionLimit: 10,
        orderedSelection: true,
        allowsEditing: false,
        exif: false,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        shouldDownloadFromNetwork: true,
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

      await deliverSelection(batch.length === 1 ? batch[0] : batch);
    } catch (error) {
      console.error('Gallery media error:', error);
      setStatus(null);
      appAlert('Selection Error', 'Failed to select media. Please try again.');
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
        await deliverSelection({
          type: 'document',
          uri: asset.uri,
          fileName: asset.name,
          fileSize: asset.size,
          mimeType: asset.mimeType || 'application/octet-stream',
        });
      } else {
        setStatus(null);
      }
    } catch (error) {
      console.error('Document picker error:', error);
      setStatus(null);
      appAlert('Selection Error', 'Failed to select document. Please try again.');
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
        await deliverSelection({
          type: 'audio',
          uri: asset.uri,
          fileName: asset.name,
          fileSize: asset.size,
          mimeType: asset.mimeType || 'audio/mpeg',
          duration: duration,
        });
      } else {
        setStatus(null);
      }
    } catch (error) {
      console.error('Audio picker error:', error);
      setStatus(null);
      appAlert('Selection Error', 'Failed to select audio. Please try again.');
    }
  }, [onMediaSelected]);

  const handleLocation = useCallback(async () => {
    setStatus({ type: 'location', message: getProcessingMessage('location') });
    await deliverSelection({
      type: 'location',
      uri: '', // No URI needed for initial selection
    });
  }, [onMediaSelected]);

  const handleOptionPress = useCallback((option: AttachmentOption) => {
    lightHaptic();
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
          <Animated.View style={menuStyle}>
            <GlassCard style={styles.menuGlass} contentStyle={styles.menuContent}>
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
                    {attachmentOptions.map((option) => renderOption(option))}
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
            </GlassCard>
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
  menuGlass: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  menuContent: {
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
