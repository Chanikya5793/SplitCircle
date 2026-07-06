// Wallpaper chooser — one sheet for every wallpaper entry point (Settings,
// chat header menu, Group Info). Catalog thumbnails set instantly from
// bundled assets (no photo permission); "From Photos" runs the gallery
// pipeline; "Remove" clears the slot. The sheet fully closes before the
// system photo picker presents (same modal-dismissal rule as HeaderMenu).

import { useTheme } from '@/context/ThemeContext';
import { WALLPAPER_CATALOG } from '@/constants/wallpaperCatalog';
import {
  clearWallpaper,
  getWallpaperSync,
  pickAndSetWallpaper,
  setWallpaperFromBundled,
  type WallpaperSlot,
} from '@/services/wallpaperService';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface WallpaperPickerSheetProps {
  visible: boolean;
  /** Slot being edited; null while hidden. */
  slot: WallpaperSlot | null;
  title?: string;
  onClose: () => void;
  /** Fired after the slot actually changed (set or removed). */
  onChanged?: (slot: WallpaperSlot) => void;
}

export const WallpaperPickerSheet = ({
  visible,
  slot,
  title = 'Wallpaper',
  onClose,
  onChanged,
}: WallpaperPickerSheetProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!slot) return null;
  const hasCurrent = Boolean(getWallpaperSync(slot));

  const surface = isDark ? '#1c1c20' : '#ffffff';

  const applyCatalog = async (id: string, source: number) => {
    lightHaptic();
    setBusyId(id);
    try {
      await setWallpaperFromBundled(slot, source);
      successHaptic();
      onChanged?.(slot);
      onClose();
    } catch (error) {
      Alert.alert('Wallpaper', error instanceof Error ? error.message : 'Could not set the wallpaper.');
    } finally {
      setBusyId(null);
    }
  };

  const applyFromPhotos = () => {
    lightHaptic();
    onClose();
    // Present the system picker only after this Modal is gone.
    setTimeout(() => {
      void pickAndSetWallpaper(slot)
        .then((entry) => {
          if (entry) onChanged?.(slot);
        })
        .catch((error) =>
          Alert.alert('Wallpaper', error instanceof Error ? error.message : 'Could not set the wallpaper.'),
        );
    }, 350);
  };

  const removeCurrent = () => {
    lightHaptic();
    void clearWallpaper(slot).then(() => onChanged?.(slot));
    onClose();
  };

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close wallpaper picker" />
      <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: insets.bottom + 12 }]}>
        <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]} />
        <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
          {title}
        </Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
        >
          {/* Gallery tile first — parity with the old flow. */}
          <TouchableOpacity
            onPress={applyFromPhotos}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Choose from your photos"
            style={[
              styles.thumb,
              styles.photosTile,
              { borderColor: theme.colors.outline, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' },
            ]}
          >
            <Ionicons name="images-outline" size={26} color={theme.colors.primary} />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
              Photos
            </Text>
          </TouchableOpacity>

          {WALLPAPER_CATALOG.map((item) => (
            <TouchableOpacity
              key={item.id}
              onPress={() => void applyCatalog(item.id, item.source)}
              activeOpacity={0.8}
              disabled={busyId !== null}
              accessibilityRole="button"
              accessibilityLabel={`${item.label} wallpaper`}
            >
              <View>
                <Image source={item.source} style={styles.thumb} accessibilityIgnoresInvertColors />
                {busyId === item.id && (
                  <View style={styles.busyOverlay}>
                    <ActivityIndicator size="small" color="#fff" />
                  </View>
                )}
              </View>
              <Text
                variant="labelSmall"
                numberOfLines={1}
                style={[styles.thumbLabel, { color: theme.colors.onSurfaceVariant }]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {hasCurrent && (
          <TouchableOpacity
            onPress={removeCurrent}
            activeOpacity={0.7}
            accessibilityRole="button"
            style={styles.removeRow}
          >
            <Ionicons name="trash-outline" size={18} color={theme.colors.error} />
            <Text style={{ color: theme.colors.error, fontWeight: '600' }}>Remove wallpaper</Text>
          </TouchableOpacity>
        )}
      </View>
    </Modal>
  );
};

const THUMB_W = 92;
const THUMB_H = 164;

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',  // modal scrim — intentionally scheme-independent
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 10,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  rail: {
    paddingHorizontal: 16,
    gap: 10,
  },
  thumb: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: 14,
  },
  photosTile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbLabel: {
    marginTop: 4,
    textAlign: 'center',
    maxWidth: THUMB_W,
  },
  removeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 10,
  },
});
