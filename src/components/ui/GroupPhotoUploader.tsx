// Group photo picker — same pipeline as the profile uploader (pick → square
// crop → Firebase Storage → group doc photoURL) with the GroupAvatar as the
// display. Only admins/owners get the edit affordance; updateGroup enforces
// the same rule server-side of the UI.

import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { storage } from '@/firebase';
import type { Group } from '@/models';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import * as ImagePicker from 'expo-image-picker';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { ActivityIndicator, IconButton, TouchableRipple } from 'react-native-paper';
import { GroupAvatar } from './AvatarPhoto';

interface GroupPhotoUploaderProps {
  group: Group;
  size?: number;
  /** Whether the current user may change the photo (admin/owner). */
  editable?: boolean;
}

export const GroupPhotoUploader = ({ group, size = 72, editable = false }: GroupPhotoUploaderProps) => {
  const { theme } = useTheme();
  const { updateGroup } = useGroups();
  const [uploading, setUploading] = useState(false);
  const [localUri, setLocalUri] = useState<string | null>(null);

  const handlePick = async () => {
    if (!editable || uploading) return;
    lightHaptic();

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please grant access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;

    const imageUri = result.assets[0].uri;
    setLocalUri(imageUri);
    setUploading(true);
    try {
      const response = await fetch(imageUri);
      const blob = await response.blob();
      const storageRef = ref(storage, `groups/${group.groupId}/photo.jpg`);
      await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
      const downloadUrl = await getDownloadURL(storageRef);
      await updateGroup(group.groupId, { photoURL: downloadUrl });
      successHaptic();
    } catch (error) {
      console.error('Error uploading group photo:', error);
      Alert.alert('Upload failed', 'Could not update the group photo. Please try again.');
      setLocalUri(null);
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      <TouchableRipple
        onPress={handlePick}
        disabled={!editable || uploading}
        accessibilityRole="button"
        accessibilityLabel={editable ? 'Change group photo' : 'Group photo'}
        style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}
        borderless
      >
        <View>
          <GroupAvatar
            photoURL={localUri ?? group.photoURL}
            name={group.name}
            size={size}
          />
          {uploading && (
            <View style={[styles.uploadingOverlay, { borderRadius: size / 2 }]}>
              <ActivityIndicator color="#fff" size="small" />
            </View>
          )}
        </View>
      </TouchableRipple>

      {editable && !uploading && (
        <View style={[styles.editBadge, { backgroundColor: theme.colors.primary }]}>
          <IconButton
            icon="camera"
            size={14}
            iconColor={theme.colors.onPrimary}
            onPress={handlePick}
            accessibilityLabel="Change group photo"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.editIcon}
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',  // scrim over arbitrary photos — intentionally scheme-independent
    justifyContent: 'center',
    alignItems: 'center',
  },
  editBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  editIcon: { margin: 0, padding: 0 },
});
