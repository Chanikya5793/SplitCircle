import { GlassView } from '@/components/GlassView';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { db, storage } from '@/firebase';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import * as ImagePicker from 'expo-image-picker';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { doc, updateDoc } from 'firebase/firestore';
import React, { useState } from 'react';
import { Alert, Image, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Avatar, IconButton, Text, TouchableRipple } from 'react-native-paper';

interface ProfilePhotoUploaderProps {
  size?: number;
  editable?: boolean;
}

export const ProfilePhotoUploader = ({ size = 80, editable = true }: ProfilePhotoUploaderProps) => {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [uploading, setUploading] = useState(false);
  const [localUri, setLocalUri] = useState<string | null>(null);

  const photoUrl = localUri || user?.photoURL;
  const initials = user?.displayName?.slice(0, 2).toUpperCase() || 'SC';

  const handlePickImage = async () => {
    if (!editable || !user) return;

    lightHaptic();

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please grant access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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

      // Update Firestore user profile
      const userRef = doc(db, 'users', user.userId);
      await updateDoc(userRef, { photoURL: downloadUrl });

      successHaptic();
    } catch (error) {
      console.error('Error uploading profile photo:', error);
      Alert.alert('Upload failed', 'Could not upload your profile photo. Please try again.');
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
            />
          )}
          
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
            iconColor="#fff"
            onPress={handlePickImage}
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
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  editIcon: {
    margin: 0,
    padding: 0,
  },
});
