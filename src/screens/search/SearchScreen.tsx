// App-wide search — a single place to find any group, expense, person, chat,
// call or setting. Runs entirely on-device: the index is built from live memory
// (see useAppSearch) and ranked locally, so results are instant. Natural-language
// questions surface an on-device AI answer card grounded in the best-matching
// group. Reachable from the native iOS 26 search tab.

import { LiquidBackground } from '@/components/LiquidBackground';
import { GlassCard, ListRow } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useTheme } from '@/context/ThemeContext';
import { useAppSearch } from '@/hooks/useAppSearch';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { groupByType, looksLikeQuestion, SECTION_LABELS, type RankedItem } from '@/services/searchService';
import { getLastSearchScope, subscribeSearchScope, type AppSearchScope } from '@/services/searchScope';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const RECENTS_KEY = 'search_recents_v1';
const SCOPE_LABELS: Record<AppSearchScope, string> = {
  expenses: 'Expenses',
  chat: 'Chat',
  calls: 'Calls',
  settings: 'Settings',
  all: 'All',
};

const SCOPE_SUGGESTIONS: Record<AppSearchScope, string[]> = {
  expenses: ['Dinner', 'Rent', 'Groceries', 'Maya paid', 'Settle up'],
  chat: ['photos', 'location', 'invoice', 'yesterday', 'from Maya'],
  calls: ['missed', 'video', 'outgoing', 'Maya', 'yesterday'],
  settings: ['privacy', 'notifications', 'AI index', 'theme', 'account'],
  all: ['Dinner', 'Maya', 'notifications', 'missed call', 'AI index'],
};

export const SearchScreen = () => {
  const navigation = useNavigation<any>();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { search, firstSearchableGroupId } = useAppSearch();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [defaultScope, setDefaultScope] = useState<AppSearchScope>(getLastSearchScope());
  const [selectedScope, setSelectedScope] = useState<AppSearchScope>(getLastSearchScope());
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    void AsyncStorage.getItem(RECENTS_KEY).then((raw) => {
      if (raw) try { setRecents(JSON.parse(raw)); } catch { /* ignore */ }
    });
    return subscribeSearchScope(setDefaultScope);
  }, []);

  // Debounce so typing stays smooth even on a large index.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 130);
    return () => clearTimeout(t);
  }, [query]);

  useFocusEffect(
    useCallback(() => {
      const next = getLastSearchScope();
      setDefaultScope(next);
      setSelectedScope(next);
      const t = setTimeout(() => inputRef.current?.focus(), 220);
      return () => clearTimeout(t);
    }, []),
  );

  const results = useMemo(() => (debounced ? search(debounced, selectedScope) : []), [debounced, search, selectedScope]);
  const sections = useMemo(() => groupByType(results), [results]);
  const getGroupIdFromItem = useCallback((item?: RankedItem): string | undefined => {
    const params = item?.params as { groupId?: string; params?: { groupId?: string } } | undefined;
    return params?.groupId ?? params?.params?.groupId ?? item?.guardEntityId;
  }, []);
  const aiGroupId = useMemo(() => {
    const best = results.find((r) => r.type === 'expense' || r.type === 'settlement' || r.type === 'group' || r.type === 'action');
    return getGroupIdFromItem(best) ?? firstSearchableGroupId;
  }, [firstSearchableGroupId, getGroupIdFromItem, results]);
  const showAiCard = debounced.length > 0 && looksLikeQuestion(debounced) && Boolean(aiGroupId);

  const rememberRecent = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    const next = [trimmed, ...recents.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())].slice(0, 8);
    setRecents(next);
    void AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  };

  const open = (item: RankedItem) => {
    selectionHaptic();
    rememberRecent(debounced);
    Keyboard.dismiss();
    navigation.navigate(item.route as never, (item.params ?? {}) as never);
  };

  const askAi = () => {
    lightHaptic();
    rememberRecent(debounced);
    Keyboard.dismiss();
    navigation.navigate(ROUTES.APP.ASK_AI as never, { groupId: aiGroupId, initialQuestion: debounced } as never);
  };

  const fieldBg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)';
  const selectedChipBg = isDark ? 'rgba(88,166,255,0.24)' : 'rgba(0,122,255,0.14)';
  const bottomPad = getFloatingTabBarContentPadding(insets.bottom, 56);
  const suggestions = SCOPE_SUGGESTIONS[selectedScope];
  const scopeOptions = useMemo<AppSearchScope[]>(
    () => ([defaultScope, 'all', 'expenses', 'chat', 'calls', 'settings'] as AppSearchScope[])
      .filter((scope, index, arr) => arr.indexOf(scope) === index),
    [defaultScope],
  );

  return (
    <LiquidBackground>
      <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
        <Text variant="titleLarge" style={[styles.heading, { color: theme.colors.onSurface }]}>
          Search {SCOPE_LABELS[selectedScope]}
        </Text>

        {/* Liquid-glass search field. */}
        <View style={[styles.field, { backgroundColor: fieldBg }]}>
          <Ionicons name="search" size={18} color={theme.colors.onSurfaceVariant} />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${SCOPE_LABELS[selectedScope].toLowerCase()}`}
            placeholderTextColor={theme.colors.onSurfaceVariant}
            style={[styles.input, { color: theme.colors.onSurface }]}
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} accessibilityLabel="Clear">
              <Ionicons name="close-circle" size={18} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.scopeRow}>
          {scopeOptions.map((scope) => {
            const selected = selectedScope === scope;
            return (
              <TouchableOpacity
                key={scope}
                style={[styles.scopeChip, { backgroundColor: selected ? selectedChipBg : fieldBg }]}
                onPress={() => {
                  selectionHaptic();
                  setSelectedScope(scope);
                }}
              >
                <Text variant="labelMedium" style={{ color: selected ? theme.colors.primary : theme.colors.onSurface }}>
                  {scope === defaultScope ? `${SCOPE_LABELS[scope]}` : SCOPE_LABELS[scope]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
        >
          {debounced.length === 0 ? (
            <View>
              {recents.length > 0 && (
                <View style={styles.block}>
                  <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>
                    Recent
                  </Text>
                  <View style={styles.chips}>
                    {recents.map((r) => (
                      <TouchableOpacity key={r} style={[styles.chip, { backgroundColor: fieldBg }]} onPress={() => setQuery(r)}>
                        <Ionicons name="time-outline" size={13} color={theme.colors.onSurfaceVariant} />
                        <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>{r}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
              <View style={styles.block}>
                <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>
                  Try
                </Text>
                <View style={styles.chips}>
                  {suggestions.map((s) => (
                    <TouchableOpacity key={s} style={[styles.chip, { backgroundColor: fieldBg }]} onPress={() => setQuery(s)}>
                      <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          ) : (
            <View style={{ gap: 14, paddingTop: 4 }}>
              {showAiCard && (
                <GlassCard style={styles.aiCard}>
                  <ListRow
                    title="Ask the on-device assistant"
                    subtitle={`“${debounced}” · answered privately on your iPhone`}
                    icon="sparkles"
                    onPress={askAi}
                  />
                </GlassCard>
              )}

              {sections.length === 0 && !showAiCard && (
                <View style={styles.empty}>
                  <Ionicons name="search-outline" size={30} color={theme.colors.onSurfaceVariant} />
                  <Text style={{ color: theme.colors.onSurfaceVariant }}>No matches for “{debounced}”.</Text>
                </View>
              )}

              {sections.map((section) => (
                <GlassCard key={section.type} style={styles.card}>
                  <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant, paddingHorizontal: 4 }]}>
                    {SECTION_LABELS[section.type]}
                  </Text>
                  {section.items.map((item) => (
                    <ListRow
                      key={item.id}
                      title={item.title}
                      subtitle={item.subtitle}
                      icon={item.icon}
                      onPress={() => open(item)}
                    />
                  ))}
                </GlassCard>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  heading: { fontWeight: '700', marginBottom: 10 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 12,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  scopeChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 15 },
  block: { marginTop: 10 },
  sectionLabel: { letterSpacing: 0.5, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  card: { paddingVertical: 6, paddingHorizontal: 8, gap: 2 },
  aiCard: { paddingVertical: 4, paddingHorizontal: 8 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 48 },
});
