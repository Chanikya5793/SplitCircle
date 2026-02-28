import { BlurView } from 'expo-blur';
import { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

interface TabBarSurfaceProps {
  children: ReactNode;
  isDark: boolean;
}

export const TabBarSurface = ({ children, isDark }: TabBarSurfaceProps) => {
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        style={[styles.surfaceBase, styles.iosSurface]}
        intensity={36}
        tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
      >
        <View pointerEvents="none" style={styles.iosHighlight} />
        {children}
      </BlurView>
    );
  }

  return (
    <View
      style={[
        styles.surfaceBase,
        styles.androidSurface,
        isDark ? styles.androidSurfaceDark : styles.androidSurfaceLight,
      ]}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  surfaceBase: {
    borderRadius: 30,
    width: '100%',
    overflow: 'hidden',
    height: 70,
    justifyContent: 'center',
  },
  iosSurface: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.20)',
  },
  iosHighlight: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 30,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  androidSurface: {
    borderWidth: 1,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  androidSurfaceDark: {
    backgroundColor: 'rgba(20, 24, 34, 0.95)',
    borderColor: 'rgba(148, 163, 184, 0.18)',
  },
  androidSurfaceLight: {
    backgroundColor: 'rgba(248, 250, 252, 0.97)',
    borderColor: 'rgba(15, 23, 42, 0.10)',
  },
});
