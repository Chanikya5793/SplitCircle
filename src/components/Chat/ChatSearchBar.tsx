import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

interface ChatSearchBarProps {
  query: string;
  onChange: (value: string) => void;
  matchCount: number;
  currentIndex: number; // 0-based; show 1-based to user
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  topInset: number;
}

export const ChatSearchBar = ({
  query,
  onChange,
  matchCount,
  currentIndex,
  onPrev,
  onNext,
  onClose,
  topInset,
}: ChatSearchBarProps) => {
  const { theme, isDark } = useTheme();
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    // Auto-focus when the bar mounts so the user can type immediately.
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const subtle = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
  const muted = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  return (
    <View style={[styles.wrap, { paddingTop: topInset + 6 }]}>
      <View style={styles.row}>
        <TouchableOpacity onPress={onClose} style={styles.button} hitSlop={8}>
          <GlassView style={styles.buttonGlass} intensity={40}>
            <Ionicons name="close" size={22} color={theme.colors.primary} />
          </GlassView>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <GlassView style={styles.searchGlass} intensity={40}>
            <Ionicons name="search" size={16} color={subtle} style={{ marginLeft: 12 }} />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={onChange}
              placeholder="Search this chat"
              placeholderTextColor={subtle}
              style={[styles.input, { color: theme.colors.onSurface }]}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
            {query.length > 0 && (
              <Text style={[styles.matchText, { color: subtle, backgroundColor: muted }]}>
                {matchCount > 0 ? `${currentIndex + 1}/${matchCount}` : '0/0'}
              </Text>
            )}
          </GlassView>
        </View>
        <View style={styles.navCluster}>
          <TouchableOpacity
            onPress={onPrev}
            disabled={matchCount === 0}
            style={[styles.navButton, matchCount === 0 && { opacity: 0.4 }]}
            hitSlop={8}
          >
            <GlassView style={styles.navGlass} intensity={40}>
              <Ionicons name="chevron-up" size={18} color={theme.colors.primary} />
            </GlassView>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onNext}
            disabled={matchCount === 0}
            style={[styles.navButton, matchCount === 0 && { opacity: 0.4 }]}
            hitSlop={8}
          >
            <GlassView style={styles.navGlass} intensity={40}>
              <Ionicons name="chevron-down" size={18} color={theme.colors.primary} />
            </GlassView>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingBottom: 12,
    zIndex: 100,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  button: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden' },
  buttonGlass: { flex: 1, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  searchGlass: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    paddingRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 0,
  },
  matchText: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  navCluster: { flexDirection: 'row', gap: 4 },
  navButton: { width: 36, height: 40, borderRadius: 18, overflow: 'hidden' },
  navGlass: { flex: 1, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});

export default ChatSearchBar;
