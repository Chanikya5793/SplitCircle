// ThemeContext v2 — theme mode (system/light/dark) + user-selectable accent.
// Preferences persist offline in a single AsyncStorage blob and apply
// instantly with the animated themeProgress crossfade the app has always had.

import {
  buildTheme,
  DEFAULT_ACCENT,
  ACCENT_IDS,
  animation,
  type AccentId,
  type AppTheme,
} from '@/theme';
import { NEUTRALS } from '@/theme/palette';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Settings, useColorScheme, View } from 'react-native';
import { SharedValue, useSharedValue, withTiming } from 'react-native-reanimated';

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemeContextType = {
  isDark: boolean;
  theme: AppTheme;
  themeProgress: SharedValue<number>;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  accent: AccentId;
  setAccent: (accent: AccentId) => void;
  /** Kept for existing callers — flips between explicit light/dark. */
  toggleTheme: () => void;
};

const STORAGE_KEY = 'appearance_v1';
const LEGACY_KEY = 'theme_preference';

const defaultThemeProgress = { value: 0 } as SharedValue<number>;
const fallbackTheme = buildTheme('light', DEFAULT_ACCENT);

const ThemeContext = createContext<ThemeContextType>({
  isDark: false,
  theme: fallbackTheme,
  themeProgress: defaultThemeProgress,
  mode: 'system',
  setMode: () => {},
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
  toggleTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

interface StoredAppearance {
  mode?: ThemeMode;
  accent?: AccentId;
}

const isValidMode = (value: unknown): value is ThemeMode =>
  value === 'system' || value === 'light' || value === 'dark';

const isValidAccent = (value: unknown): value is AccentId =>
  typeof value === 'string' && (ACCENT_IDS as string[]).includes(value);

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [accent, setAccentState] = useState<AccentId>(DEFAULT_ACCENT);
  const [hydrated, setHydrated] = useState(false);

  const isDark = (mode === 'system' ? systemScheme : mode) === 'dark';
  const themeProgress = useSharedValue(isDark ? 1 : 0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const stored: StoredAppearance = JSON.parse(raw);
          if (cancelled) return;
          if (isValidMode(stored.mode)) setModeState(stored.mode);
          if (isValidAccent(stored.accent)) setAccentState(stored.accent);
        } else {
          // Migrate the legacy boolean preference once, then leave it behind.
          const legacy = await AsyncStorage.getItem(LEGACY_KEY);
          if (cancelled) return;
          if (legacy === 'dark' || legacy === 'light') {
            setModeState(legacy);
            await AsyncStorage.setItem(
              STORAGE_KEY,
              JSON.stringify({ mode: legacy, accent: DEFAULT_ACCENT }),
            );
          }
        }
      } catch (error) {
        console.error('Failed to load appearance preference', error);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on change (after hydration, so we don't clobber stored values
  // with defaults during the initial load).
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, accent })).catch((error) =>
        console.error('Failed to save appearance preference', error),
      );
    }, 50);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [mode, accent, hydrated]);

  useEffect(() => {
    themeProgress.value = withTiming(isDark ? 1 : 0, {
      duration: animation.themeTransitionMs,
    });
    // Sync to NSUserDefaults so AppDelegate can apply
    // window.overrideUserInterfaceStyle — keeps the native UITabBarController
    // in step with the in-app theme.
    if (Platform.OS === 'ios') {
      Settings.set({ RNThemeIsDark: isDark ? 1 : 0 });
    }
  }, [isDark]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const setAccent = useCallback((next: AccentId) => setAccentState(next), []);
  const toggleTheme = useCallback(() => {
    setModeState((prev) => {
      const currentlyDark =
        (prev === 'system' ? systemScheme : prev) === 'dark';
      return currentlyDark ? 'light' : 'dark';
    });
  }, [systemScheme]);

  const theme = useMemo(
    () => buildTheme(isDark ? 'dark' : 'light', accent),
    [isDark, accent],
  );

  const value = useMemo(
    () => ({ isDark, theme, themeProgress, mode, setMode, accent, setAccent, toggleTheme }),
    [isDark, theme, themeProgress, mode, setMode, accent, setAccent, toggleTheme],
  );

  // Hold the first paint until the stored preference is read (~ms). Render a
  // scheme-correct backdrop rather than null so there's no white flash if the
  // native splash dismisses early. Kills the wrong-theme flash the old
  // fire-and-forget load caused.
  if (!hydrated) {
    const backdrop =
      systemScheme === 'dark' ? NEUTRALS.dark.appBackground : NEUTRALS.light.appBackground;
    return <View style={{ flex: 1, backgroundColor: backdrop }} />;
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
