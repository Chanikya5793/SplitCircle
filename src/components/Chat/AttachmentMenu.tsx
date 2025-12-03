import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef } from 'react';
import {
    Alert, Animated,
    Dimensions,
    Modal, Platform, Pressable,
    StyleSheet,
    TouchableOpacity,
    View
} from 'react-native';
import { Text } from 'react-native-paper';

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
  onMediaSelected: (media: SelectedMedia) => void;
}

interface AttachmentOption {
  id: AttachmentType;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  backgroundColor: string;
}

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
    label: 'Gallery',
    color: '#FFFFFF',
    backgroundColor: '#9C27B0',
  },
  {
    id: 'video',
    icon: 'videocam',
    label: 'Video',
    color: '#FFFFFF',
    backgroundColor: '#FF5722',
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

export const AttachmentMenu = ({ visible, onClose, onMediaSelected }: AttachmentMenuProps) => {
  const { theme, isDark } = useTheme();
  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 300,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, slideAnim, fadeAnim]);

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
    if (!hasPermission) return;

    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.8,
        allowsEditing: false,
        exif: false,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        onClose();
        // Small delay to allow modal to close before opening preview
        setTimeout(() => {
          onMediaSelected({
            type: 'camera',
            uri: asset.uri,
            fileName: asset.fileName || `IMG_${Date.now()}.jpg`,
            fileSize: asset.fileSize,
            mimeType: asset.mimeType || 'image/jpeg',
            width: asset.width,
            height: asset.height,
          });
        }, 500);
      }
    } catch (error) {
      console.error('Camera error:', error);
      Alert.alert('Camera Error', 'Failed to capture photo. Please try again.');
    }
  }, [onMediaSelected, onClose]);

  const handleGalleryImage = useCallback(async () => {
    const hasPermission = await requestMediaLibraryPermission();
    if (!hasPermission) return;

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        quality: 0.8,
        allowsMultipleSelection: false,
        allowsEditing: false,
        exif: false,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        onClose();
        // Small delay to allow modal to close before opening preview
        setTimeout(() => {
          onMediaSelected({
            type: 'image',
            uri: asset.uri,
            fileName: asset.fileName || `IMG_${Date.now()}.jpg`,
            fileSize: asset.fileSize,
            mimeType: asset.mimeType || 'image/jpeg',
            width: asset.width,
            height: asset.height,
          });
        }, 500);
      }
    } catch (error) {
      console.error('Gallery image error:', error);
      Alert.alert('Selection Error', 'Failed to select image. Please try again.');
    }
  }, [onMediaSelected, onClose]);

  const handleGalleryVideo = useCallback(async () => {
    const hasPermission = await requestMediaLibraryPermission();
    if (!hasPermission) return;

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'videos',
        allowsMultipleSelection: false,
        exif: false,
        // Use medium quality preset to avoid PHPhotosErrorDomain error 3164 on iOS
        // This ensures proper video transcoding for iCloud-stored videos
        videoExportPreset: ImagePicker.VideoExportPreset.MediumQuality,
        // Video quality setting (0-1)
        videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        onClose();
        // Small delay to allow modal to close before opening preview
        setTimeout(() => {
          onMediaSelected({
            type: 'video',
            uri: asset.uri,
            fileName: asset.fileName || `VID_${Date.now()}.mp4`,
            fileSize: asset.fileSize,
            mimeType: asset.mimeType || 'video/mp4',
            width: asset.width,
            height: asset.height,
            duration: asset.duration ? asset.duration * 1000 : undefined,
          });
        }, 500);
      }
    } catch (error) {
      console.error('Gallery video error:', error);
      Alert.alert('Selection Error', 'Failed to select video. Please try again.');
    }
  }, [onMediaSelected, onClose]);

  const handleDocument = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        onClose();
        // Small delay to allow modal to close before opening preview
        setTimeout(() => {
          onMediaSelected({
            type: 'document',
            uri: asset.uri,
            fileName: asset.name,
            fileSize: asset.size,
            mimeType: asset.mimeType || 'application/octet-stream',
          });
        }, 500);
      }
    } catch (error) {
      console.error('Document picker error:', error);
      Alert.alert('Selection Error', 'Failed to select document. Please try again.');
    }
  }, [onMediaSelected, onClose]);

  const handleAudio = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        let duration: number | undefined;

        // Try to get duration
        try {
          const { sound } = await Audio.Sound.createAsync({ uri: asset.uri });
          const status = await sound.getStatusAsync();
          if (status.isLoaded) {
            duration = status.durationMillis;
          }
          await sound.unloadAsync();
        } catch (e) {
          console.warn('Failed to get audio duration:', e);
        }

        onClose();
        // Small delay to allow modal to close before opening preview
        setTimeout(() => {
          onMediaSelected({
            type: 'audio',
            uri: asset.uri,
            fileName: asset.name,
            fileSize: asset.size,
            mimeType: asset.mimeType || 'audio/mpeg',
            duration: duration,
          });
        }, 500);
      }
    } catch (error) {
      console.error('Audio picker error:', error);
      Alert.alert('Selection Error', 'Failed to select audio. Please try again.');
    }
  }, [onMediaSelected, onClose]);

  const handleLocation = useCallback(() => {
    // Location sharing would require additional setup
    console.log('Location sharing coming soon');
    onClose();
  }, [onClose]);

  const handleOptionPress = useCallback((option: AttachmentOption) => {
    switch (option.id) {
      case 'camera':
        handleCamera();
        break;
      case 'image':
        handleGalleryImage();
        break;
      case 'video':
        handleGalleryVideo();
        break;
      case 'document':
        handleDocument();
        break;
      case 'audio':
        handleAudio();
        break;
      case 'location':
        handleLocation();
        break;
    }
  }, [handleCamera, handleGalleryImage, handleGalleryVideo, handleDocument, handleAudio, handleLocation]);

  const renderOption = (option: AttachmentOption) => {
    return (
      <TouchableOpacity
        key={option.id}
        style={styles.optionContainer}
        onPress={() => handleOptionPress(option)}
        activeOpacity={0.7}
      >
        <View style={[styles.optionButton, { backgroundColor: option.backgroundColor }]}>
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
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        {/* Backdrop */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <Animated.View
            style={[
              styles.backdrop,
              { opacity: fadeAnim },
            ]}
          />
        </Pressable>

        {/* Menu */}
        <Animated.View
          style={[
            styles.menuContainer,
            {
              backgroundColor: isDark ? 'rgba(30, 30, 30, 0.98)' : 'rgba(255, 255, 255, 0.98)',
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          {/* Handle */}
          <View style={styles.handleContainer}>
            <View style={[styles.handle, { backgroundColor: isDark ? '#555' : '#ccc' }]} />
          </View>

          {/* Options Grid */}
          <View style={styles.optionsGrid}>
            {ATTACHMENT_OPTIONS.map((option) => renderOption(option))}
          </View>

          {/* Cancel Button */}
          <TouchableOpacity
            style={[
              styles.cancelButton,
              { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' },
            ]}
            onPress={onClose}
            activeOpacity={0.7}
          >
            <Text style={[styles.cancelText, { color: theme.colors.error }]}>Cancel</Text>
          </TouchableOpacity>
        </Animated.View>
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
});

export default AttachmentMenu;
