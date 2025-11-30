import { darkTheme, lightTheme } from '@/constants/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SharedValue, useSharedValue, withTiming } from 'react-native-reanimated';

type ThemeContextType = {
    isDark: boolean;
    toggleTheme: () => void;
    theme: typeof lightTheme;
    themeProgress: SharedValue<number>;
};

// Create a dummy shared value for default context to avoid crashes if used outside provider
// In reality, this should never happen if the app is wrapped correctly.
const defaultThemeProgress = { value: 0 } as SharedValue<number>;

const ThemeContext = createContext<ThemeContextType>({
    isDark: false,
    toggleTheme: () => { },
    theme: lightTheme,
    themeProgress: defaultThemeProgress,
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
    const systemScheme = useColorScheme();
    const [isDark, setIsDark] = useState(systemScheme === 'dark');
    const themeProgress = useSharedValue(isDark ? 1 : 0);

    useEffect(() => {
        loadTheme();
    }, []);

    useEffect(() => {
        themeProgress.value = withTiming(isDark ? 1 : 0, { duration: 500 });
    }, [isDark]);

    const loadTheme = async () => {
        try {
            const savedTheme = await AsyncStorage.getItem('theme_preference');
            if (savedTheme) {
                const isDarkSaved = savedTheme === 'dark';
                setIsDark(isDarkSaved);
                themeProgress.value = isDarkSaved ? 1 : 0;
            }
        } catch (error) {
            console.error('Failed to load theme preference', error);
        }
    };

    const toggleTheme = async () => {
        try {
            const newIsDark = !isDark;
            setIsDark(newIsDark);
            await AsyncStorage.setItem('theme_preference', newIsDark ? 'dark' : 'light');
        } catch (error) {
            console.error('Failed to save theme preference', error);
        }
    };

    const theme = isDark ? darkTheme : lightTheme;

    return (
        <ThemeContext.Provider value={{ isDark, toggleTheme, theme, themeProgress }}>
            {children}
        </ThemeContext.Provider>
    );
};
