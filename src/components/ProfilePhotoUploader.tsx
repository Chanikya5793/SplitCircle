import { FONT_CAP } from '@/utils/a11yText';
import { APP_NAME } from '@/constants/appInfo';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { appAlert } from '@/utils/appAlert';
import { auth, db, storage } from '@/firebase';
import { propagateProfileToGroups } from '@/services/profilePropagation';
import { updateProfile } from 'firebase/auth';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import * as ImagePicker from 'expo-image-picker';
import { doc, updateDoc } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Avatar, IconButton, TouchableRipple } from 'react-native-paper';

interface ProfilePhotoUploaderProps {
  size?: number;
  editable?: boolean;
}

export const ProfilePhotoUploader = ({ size = 80, editable = true }: ProfilePhotoUploaderProps) => {
  const { user } = useAuth();
  const { groups } = useGroups();
  const { theme } = useTheme();
  const [uploading, setUploading] = useState(false);
  const [localUri, setLocalUri] = useState<string | null>(null);

  const photoUrl = localUri || user?.photoURL;
  const initials = (() => {
    const words = user?.displayName?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return APP_NAME.slice(0, 2).toUpperCase();
  })();

  const handlePickImage = async () => {
    if (!editable || !user) return;

    lightHaptic();

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      appAlert('Permission required', 'Please grant access to your photo library.');
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
      // Upload to Firebase Storage
      const response = await fetch(imageUri);
      const blob = await response.blob();
      
      const storageRef = ref(storage, `users/${user.userId}/profile.jpg`);
      await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
      
      const downloadUrl = await getDownloadURL(storageRef);

      // Update Firestore user profile (authoritative)
      const userRef = doc(db, 'users', user.userId);
      await updateDoc(userRef, { photoURL: downloadUrl });

      // Keep the Firebase Auth profile in step so auth-derived surfaces
      // (fresh installs before the first snapshot) show the same photo.
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { photoURL: downloadUrl }).catch(() => {});
      }

      // Push the new photo into every group's denormalized member entry —
      // that's where friends lists, chats, and expense rows read it from.
      void propagateProfileToGroups(user.userId, { photoURL: downloadUrl }, groups);

      successHaptic();
    } catch (error) {
      console.error('Error uploading profile photo:', error);
      appAlert('Upload failed', 'Could not upload your profile photo. Please try again.');
      setLocalUri(null); // Revert to previous photo
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      <TouchableRipple
        onPress={handlePickImage}
        disabled={!editable || uploading}
        accessibilityRole="button"
        accessibilityLabel="Change profile photo"
        style={[styles.avatarContainer, { width: size, height: size, borderRadius: size / 2 }]}
        borderless
      >
        <View>
          {photoUrl ? (
            <Image
              source={{ uri: photoUrl }}
              style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
            />
          ) : (
            <Avatar.Text
              size={size}
              label={initials}
              style={{ backgroundColor: theme.colors.primaryContainer }}
              color={theme.colors.onPrimaryContainer}
        maxFontSizeMultiplier={FONT_CAP.avatarMonogram}
      />
          )}
          
          {uploading && (
            <View style={[styles.uploadingOverlay, { borderRadius: size / 2 }]}>
              <ActivityIndicator color={theme.colors.onPrimary} size="small" />
            </View>
          )}
        </View>
      </TouchableRipple>

      {editable && !uploading && (
        <View style={[styles.editBadge, { backgroundColor: theme.colors.primary }]}>
          <IconButton
            icon="camera"
            size={16}
            iconColor={theme.colors.onPrimary}
            onPress={handlePickImage}
            accessibilityLabel="Change profile photo"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.editIcon}
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarContainer: {
    overflow: 'hidden',
  },
  avatar: {
    resizeMode: 'cover',
  },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',  // scrim over arbitrary photos — intentionally scheme-independent
    justifyContent: 'center',
    alignItems: 'center',
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  editIcon: {
    margin: 0,
    padding: 0,
  },
});
