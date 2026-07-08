// Unified avatars — photo when available, initials otherwise. One component
// pair so every surface (friends, chats, groups, calls) renders identity the
// same way instead of hand-rolling Avatar.Text fallbacks per screen.

import { useTheme } from '@/context/ThemeContext';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Avatar } from 'react-native-paper';

const initialsFor = (name?: string | null): string => {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return '?';
};

interface UserAvatarProps {
  photoURL?: string | null;
  displayName?: string | null;
  size?: number;
}

/** A person: photo → initials. Falls back to initials if the image 404s. */
export const UserAvatar = ({ photoURL, displayName, size = 40 }: UserAvatarProps) => {
  const { theme } = useTheme();
  const { hidePhoto } = usePrivacyMask();
  const [failed, setFailed] = useState(false);
  const uri = !failed && photoURL?.trim() ? photoURL.trim() : null;

  // Privacy guard "hide photos": drop to a neutral silhouette — no photo AND
  // no initials, so neither face nor name leaks.
  if (hidePhoto()) {
    return (
      <View
        style={[
          styles.disc,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.primaryContainer },
        ]}
      >
        <Ionicons name="person" size={size * 0.5} color={theme.colors.onPrimaryContainer} />
      </View>
    );
  }

  if (uri) {
    return (
      <Image
        source={{ uri }}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <Avatar.Text
      size={size}
      label={initialsFor(displayName)}
      style={{ backgroundColor: theme.colors.primaryContainer }}
      color={theme.colors.onPrimaryContainer}
      labelStyle={{ fontWeight: '700' }}
    />
  );
};

interface GroupAvatarProps {
  photoURL?: string | null;
  name?: string | null;
  size?: number;
}

/** A group: photo → people glyph on an accent-tinted disc. */
export const GroupAvatar = ({ photoURL, name, size = 40 }: GroupAvatarProps) => {
  const { theme } = useTheme();
  const { hidePhoto } = usePrivacyMask();
  const [failed, setFailed] = useState(false);
  const uri = !failed && photoURL?.trim() ? photoURL.trim() : null;

  // Privacy guard "hide photos": neutral people glyph, no photo/initials.
  if (hidePhoto()) {
    return (
      <View
        style={[
          styles.disc,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.secondaryContainer },
        ]}
      >
        <Ionicons name="people" size={size * 0.5} color={theme.colors.onSecondaryContainer} />
      </View>
    );
  }

  if (uri) {
    return (
      <Image
        source={{ uri }}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityIgnoresInvertColors
      />
    );
  }
  const initials = initialsFor(name);
  if (initials !== '?') {
    return (
      <Avatar.Text
        size={size}
        label={initials}
        style={{ backgroundColor: theme.colors.secondaryContainer }}
        color={theme.colors.onSecondaryContainer}
        labelStyle={{ fontWeight: '700' }}
      />
    );
  }
  return (
    <View
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.secondaryContainer,
        },
      ]}
    >
      <Ionicons name="people" size={size * 0.5} color={theme.colors.onSecondaryContainer} />
    </View>
  );
};

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center' },
});
