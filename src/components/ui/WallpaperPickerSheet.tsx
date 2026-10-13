// Wallpaper chooser — one sheet for every wallpaper entry point (Settings,
// chat header menu, Group Info). It drops DOWN from the top over a full-screen
// grey scrim that fades in/out. Catalog thumbnails set instantly: 'blob'
// entries apply the animated liquid backdrop in that palette, 'photo' entries
// copy a bundled image. "From Photos" runs the gallery pipeline; "Remove"
// clears the slot. The sheet fully closes before the system photo picker
// presents (same modal-dismissal rule as HeaderMenu).

import { useTheme } from '@/context/ThemeContext';
import { GlassCard } from '@/components/ui/GlassCard';
import { ScrimBackdrop } from '@/components/ui/ScrimBackdrop';
import { appAlert } from '@/utils/appAlert';
import { WALLPAPER_CATALOG, type CatalogWallpaper } from '@/constants/wallpaperCatalog';
import { LiveWallpaper } from '@/components/LiveWallpaper';
import {
  clearWallpaper,
  copyWallpaper,
  getWallpaperSync,
  pickAndSetWallpaper,
  setWallpaperBlob,
  setWallpaperFromBundled,
  setWallpaperLive,
  setWallpaperSolid,
  type WallpaperSlot,
} from '@/services/wallpaperService';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface WallpaperPickerSheetProps {
  visible: boolean;
  /** Slot being edited; null while hidden. */
  slot: WallpaperSlot | null;
  title?: string;
  /** Optional existing slot this picker can match in one tap. */
  mirrorSlot?: WallpaperSlot;
  mirrorLabel?: string;
  /** Optional destination that receives this slot's explicitly saved wallpaper. */
  copyToSlot?: WallpaperSlot;
  copyToLabel?: string;
  onClose: () => void;
  /** Fired after the slot actually changed (set or removed). */
  onChanged?: (slot: WallpaperSlot) => void;
}

export const WallpaperPickerSheet = ({
  visible,
  slot,
  title = 'Wallpaper',
  mirrorSlot,
  mirrorLabel,
  copyToSlot,
  copyToLabel,
  onClose,
  onChanged,
}: WallpaperPickerSheetProps) => {
  const { theme, isDark, themeProgress } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Entrance: the sheet slides DOWN from above while the Modal's fade brings
  // the full-screen scrim in softly. Measured height keeps the slide exact.
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(420);
  useEffect(() => {
    if (visible) {
      slide.setValue(0);
      Animated.timing(slide, {
        toValue: 1,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [visible, slide]);

  if (!slot) return null;
  const current = getWallpaperSync(slot);
  const hasCurrent = Boolean(current);
  /** Marks the tile that matches what this slot shows now. */
  const isCurrent = (item: CatalogWallpaper): boolean => {
    if (!current) return false;
    if (item.kind === 'live') return current.kind === 'live' && current.scene === item.scene;
    if (item.kind === 'solid') return current.kind === 'solid' && current.light === item.light && current.dark === item.dark;
    if (item.kind === 'blob') {
      if (current.kind !== 'blob') return false;
      return item.adaptive ? current.adaptive === true : !current.adaptive && current.light.join() === item.light.join();
    }
    return false;
  };

  const applyCatalog = async (item: CatalogWallpaper) => {
    lightHaptic();
    setBusyId(item.id);
    try {
      if (item.kind === 'live') await setWallpaperLive(slot, item.scene);
      else if (item.kind === 'blob') await setWallpaperBlob(slot, item.light, item.dark, item.adaptive);
      else if (item.kind === 'solid') await setWallpaperSolid(slot, item.light, item.dark);
      else await setWallpaperFromBundled(slot, item.source);
      successHaptic();
      onChanged?.(slot);
      onClose();
    } catch (error) {
      console.warn('[WallpaperPicker] Catalog wallpaper failed:', error);
      appAlert('Could not set wallpaper', 'Your current wallpaper is unchanged. Try again.');
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
        .catch((error) => {
          console.warn('[WallpaperPicker] Photo wallpaper failed:', error);
          appAlert('Could not set wallpaper', 'Your current wallpaper is unchanged. Try another photo.');
        });
    }, 350);
  };

  const removeCurrent = () => {
    lightHaptic();
    void clearWallpaper(slot).then(() => onChanged?.(slot));
    onClose();
  };

  const applyMirror = async () => {
    if (!mirrorSlot) return;
    lightHaptic();
    setBusyId('mirror');
    try {
      await copyWallpaper(mirrorSlot, slot);
      successHaptic();
      onChanged?.(slot);
      onClose();
    } catch (error) {
      console.warn('[WallpaperPicker] Match failed:', error);
      appAlert('Could not match wallpaper', 'The current chat wallpaper is unchanged. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const copyCurrentTo = async () => {
    if (!copyToSlot) return;
    lightHaptic();
    setBusyId('copy-out');
    try {
      await copyWallpaper(slot, copyToSlot);
      successHaptic();
      onChanged?.(copyToSlot);
      onClose();
    } catch (error) {
      console.warn('[WallpaperPicker] Copy failed:', error);
      appAlert('Could not copy wallpaper', 'The other chat wallpaper is unchanged. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  // Slides UP from the bottom while the Modal's fade brings in the scrim.
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 60, 0] });

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close wallpaper picker">
        <ScrimBackdrop />
      </Pressable>
      <Animated.View
        onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
        style={[styles.sheetAnchor, { transform: [{ translateY }] }]}
      >
        <GlassCard
          role="floating"
          radius={24}
          style={styles.sheet}
          contentStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 12 }]}
        >
        <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]} />
        <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
          {title}
        </Text>

        {mirrorSlot && mirrorLabel && (
          <TouchableOpacity
            onPress={() => void applyMirror()}
            disabled={busyId !== null}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={mirrorLabel}
            style={[styles.matchRow, { borderColor: theme.colors.outline, backgroundColor: `${theme.colors.primary}10` }]}
          >
            <Ionicons name="copy-outline" size={19} color={theme.colors.primary} />
            <View style={styles.matchCopy}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>{mirrorLabel}</Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>Keeps photos and animated colors in sync</Text>
            </View>
            {busyId === 'mirror' ? <ActivityIndicator size="small" color={theme.colors.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.colors.onSurfaceVariant} />}
          </TouchableOpacity>
        )}

        {copyToSlot && copyToLabel && hasCurrent && (
          <TouchableOpacity
            onPress={() => void copyCurrentTo()}
            disabled={busyId !== null}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={copyToLabel}
            style={[styles.matchRow, { borderColor: theme.colors.outline, backgroundColor: `${theme.colors.primary}10` }]}
          >
            <Ionicons name="arrow-up-outline" size={19} color={theme.colors.primary} />
            <View style={styles.matchCopy}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>{copyToLabel}</Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>Copies this conversation’s saved wallpaper</Text>
            </View>
            {busyId === 'copy-out' ? <ActivityIndicator size="small" color={theme.colors.primary} /> : <Ionicons name="chevron-forward" size={18} color={theme.colors.onSurfaceVariant} />}
          </TouchableOpacity>
        )}

        <ScrollView style={[styles.sections, { maxHeight: windowHeight * 0.58 }]} showsVerticalScrollIndicator={false}>
          {SECTIONS.map((section) => (
            <View key={section.key} style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  {section.title}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {section.hint}
                </Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
                {section.key === 'photo' ? (
                  <TouchableOpacity
                    onPress={applyFromPhotos}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Choose from your photos"
                  >
                    <View
                      style={[
                        styles.thumb,
                        styles.photosTile,
                        { borderColor: theme.colors.outline, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' },
                      ]}
                    >
                      <Ionicons name="images-outline" size={26} color={theme.colors.primary} />
                    </View>
                    <Text variant="labelSmall" numberOfLines={1} style={[styles.thumbLabel, { color: theme.colors.onSurfaceVariant }]}>
                      Your photos
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {WALLPAPER_CATALOG.filter((item) => section.kinds.includes(item.kind)).map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    onPress={() => void applyCatalog(item)}
                    activeOpacity={0.8}
                    disabled={busyId !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.label} wallpaper`}
                  >
                    <View style={styles.thumbFrame}>
                      {item.kind === 'live' ? (
                        <View style={[styles.thumb, styles.liveThumb]}>
                          <LiveWallpaper
                            scene={item.scene}
                            animate={visible && !theme.reduceMotion}
                            mode={themeProgress}
                            width={THUMB_W}
                            height={THUMB_H}
                            speed={2}
                            startAt={20 + item.label.length * 7}
                          />
                        </View>
                      ) : item.kind === 'solid' ? (
                        <View style={[styles.thumb, { backgroundColor: isDark ? item.dark : item.light }]} />
                      ) : (
                        <Image
                          source={item.kind === 'blob' ? item.thumb : item.source}
                          style={styles.thumb}
                          accessibilityIgnoresInvertColors
                        />
                      )}
                      {item.kind === 'blob' || item.kind === 'live' ? (
                        <View style={styles.animBadge} pointerEvents="none">
                          <Ionicons name={item.kind === 'live' ? 'play' : 'sparkles'} size={10} color="#fff" />
                        </View>
                      ) : null}
                      {isCurrent(item) ? (
                        <View style={[styles.currentRing, { borderColor: theme.colors.primary }]} pointerEvents="none" />
                      ) : null}
                      {busyId === item.id && (
                        <View style={styles.busyOverlay}>
                          <ActivityIndicator size="small" color="#fff" />
                        </View>
                      )}
                    </View>
                    <Text
                      variant="labelSmall"
                      numberOfLines={1}
                      style={[styles.thumbLabel, { color: isCurrent(item) ? theme.colors.primary : theme.colors.onSurfaceVariant }]}
                    >
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
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
        </GlassCard>
      </Animated.View>
    </Modal>
  );
};

const THUMB_W = 84;
const THUMB_H = 150;

const SECTIONS: { key: string; title: string; hint: string; kinds: CatalogWallpaper['kind'][] }[] = [
  { key: 'live', title: 'Live', hint: 'Animated scenes', kinds: ['live'] },
  { key: 'blob', title: 'Liquid', hint: 'Drifting colour', kinds: ['blob'] },
  { key: 'photo', title: 'Photos', hint: 'Still images', kinds: ['photo'] },
  { key: 'solid', title: 'Solid', hint: 'Calm and simple', kinds: ['solid'] },
];

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheetAnchor: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheet: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  sheetContent: {
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
  matchRow: {
    minHeight: 54,
    marginHorizontal: 16,
    marginBottom: 14,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  matchCopy: {
    flex: 1,
    gap: 1,
  },
  sections: {
    // maxHeight is set inline from the window height so the title, the match
    // row and Remove always fit; the sections scroll inside it.
    flexGrow: 0,
  },
  section: {
    marginBottom: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    paddingHorizontal: 18,
    marginBottom: 8,
  },
  rail: {
    paddingHorizontal: 16,
    gap: 10,
  },
  thumbFrame: {
    borderRadius: 14,
  },
  liveThumb: {
    overflow: 'hidden',
  },
  currentRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 14,
    borderWidth: 2.5,
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
  animBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
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
