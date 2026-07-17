// App-wide search — a single place to find any group, expense, person, chat,
// call or setting. Runs entirely on-device: the index is built from live memory
// (see useAppSearch) and ranked locally, so results are instant. Natural-language
// questions surface an on-device AI answer card grounded in the best-matching
// group. Reachable from the native iOS 26 search tab.

import { LiquidBackground } from '@/components/LiquidBackground';
import { getFloatingTabBarEnvelopeHeight } from '@/components/tabbar/tabBarMetrics';
import { GlassCard, ListRow } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useTheme } from '@/context/ThemeContext';
import { useAppSearch } from '@/hooks/useAppSearch';
import { groupByType, highlightSegments, looksLikeQuestion, SECTION_LABELS, type RankedItem } from '@/services/searchService';
import { getLastSearchScope, subscribeSearchScope, type AppSearchScope } from '@/services/searchScope';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const RECENTS_KEY = 'search_recents_v1';
const SCOPE_LABELS: Record<AppSearchScope, string> = {
  expenses: 'Expenses',
  chat: 'Chat',
  calls: 'Calls',
  settings: 'Settings',
  all: 'All',
};

// Fallback "try this" chips, used only until (or when) the user has no real
// data to draw dynamic suggestions from. See useAppSearch.getSuggestions.
const FALLBACK_SUGGESTIONS: Record<AppSearchScope, string[]> = {
  expenses: ['Dinner', 'Rent', 'Groceries', 'Settle up'],
  chat: ['photos', 'location', 'invoice', 'yesterday'],
  calls: ['missed', 'video', 'outgoing', 'yesterday'],
  settings: ['privacy', 'notifications', 'AI index', 'theme', 'account'],
  all: ['Dinner', 'notifications', 'missed call', 'AI index'],
};

// Renders text with the query's matched substrings emphasised (bold + accent),
// so results make it obvious *why* they matched. ListRow only accepts a plain
// string title, so result rows are rendered locally to support rich highlights.
const HighlightedText = ({
  text,
  query,
  color,
  highlightColor,
  fontSize,
  fontWeight,
  numberOfLines,
  marginTop,
}: {
  text: string;
  query: string;
  color: string;
  highlightColor: string;
  fontSize: number;
  fontWeight?: '400' | '500' | '600' | '700';
  numberOfLines?: number;
  marginTop?: number;
}) => {
  const segments = useMemo(() => highlightSegments(text, query), [text, query]);
  return (
    <Text numberOfLines={numberOfLines} style={{ color, fontSize, fontWeight, marginTop }}>
      {segments.map((seg, i) =>
        seg.match ? (
          <Text key={i} style={{ color: highlightColor, fontWeight: '700' }}>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
};

// Local search-result row (mirrors ListRow's look) with highlighted title/subtitle.
const ResultRow = ({ item, query, onPress }: { item: RankedItem; query: string; onPress: () => void }) => {
  const { theme } = useTheme();
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={item.title} style={styles.resultRow}>
      <View style={[styles.resultIcon, { backgroundColor: theme.colors.primaryContainer, borderRadius: theme.radius.pill }]}>
        <Icon source={item.icon} size={18} color={theme.colors.primary} />
      </View>
      <View style={styles.resultCopy}>
        <HighlightedText
          text={item.title}
          query={query}
          color={theme.colors.onSurface}
          highlightColor={theme.colors.primary}
          fontSize={theme.typography.body.fontSize}
          fontWeight="500"
          numberOfLines={1}
        />
        {item.subtitle ? (
          <HighlightedText
            text={item.subtitle}
            query={query}
            color={theme.colors.muted}
            highlightColor={theme.colors.primary}
            fontSize={theme.typography.caption.fontSize}
            numberOfLines={2}
            marginTop={1}
          />
        ) : null}
      </View>
      <Icon source="chevron-right" size={20} color={theme.colors.muted} />
    </TouchableOpacity>
  );
};

// A recent search. Swipe left to delete an individual entry — the removal
// affordance Apple asks for on recents (alongside the "Clear all" in the section
// header). Rendered as a row (not a chip) so the swipe has something to reveal.
const RecentRow = ({
  value,
  onPress,
  onRemove,
}: {
  value: string;
  onPress: () => void;
  onRemove: () => void;
}) => {
  const { theme } = useTheme();
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={36}
      renderRightActions={() => (
        <TouchableOpacity
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${value} from recent searches`}
          style={[styles.recentDelete, { backgroundColor: theme.colors.error }]}
        >
          <Ionicons name="trash-outline" size={18} color={theme.colors.onError ?? '#fff'} />
        </TouchableOpacity>
      )}
    >
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={value}
        style={[styles.recentRow, { backgroundColor: theme.colors.surface }]}
      >
        <Ionicons name="time-outline" size={16} color={theme.colors.onSurfaceVariant} />
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.onSurface }}>
          {value}
        </Text>
        <Ionicons name="chevron-forward" size={15} color={theme.colors.muted} />
      </TouchableOpacity>
    </ReanimatedSwipeable>
  );
};

export const SearchScreen = () => {
  const navigation = useNavigation<any>();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { search, firstSearchableGroupId, getSuggestions } = useAppSearch();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [defaultScope, setDefaultScope] = useState<AppSearchScope>(getLastSearchScope());
  const [selectedScope, setSelectedScope] = useState<AppSearchScope>(getLastSearchScope());
  const inputRef = useRef<TextInput>(null);

  // The tab bar sits over the bottom of this screen, so the field must clear it when
  // idle — but once the keyboard is up it covers the tab bar, and that same padding
  // would leave the field floating in a gap. Track the keyboard and swap.
  const [keyboardUp, setKeyboardUp] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(RECENTS_KEY).then((raw) => {
      if (raw) try { setRecents(JSON.parse(raw)); } catch { /* ignore */ }
    });
    return subscribeSearchScope(setDefaultScope);
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardUp(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardUp(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
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

  const persistRecents = (next: string[]) => {
    setRecents(next);
    void AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  };

  const rememberRecent = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    persistRecents([trimmed, ...recents.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())].slice(0, 8));
  };

  const removeRecent = (value: string) => {
    selectionHaptic();
    persistRecents(recents.filter((r) => r !== value));
  };

  const clearAllRecents = () => {
    lightHaptic();
    persistRecents([]);
  };

  /**
   * Close search and put the user back on the tab they came from. Search lives as a
   * tab (a native tab press can't be intercepted, and navigating a tab pops any modal
   * — see the notes on the SEARCH_TAB screen), so there's usually nothing to `goBack`
   * to: we walk the tab navigator's history instead.
   */
  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    const state = navigation.getState?.();
    const history = state?.history ?? [];
    const prevKey = history[history.length - 2]?.key;
    const backTo =
      state?.routes?.find((r: any) => r.key === prevKey)?.name ??
      state?.routes?.find((r: any) => r.name !== ROUTES.APP.SEARCH_TAB)?.name;
    if (backTo) navigation.navigate(backTo);
  }, [navigation]);

  // Close the overlay BEFORE navigating, otherwise it stays alive underneath the
  // destination and reappears when the user comes back.
  const open = (item: RankedItem) => {
    selectionHaptic();
    rememberRecent(debounced);
    dismiss();
    navigation.navigate(item.route as never, (item.params ?? {}) as never);
  };

  const askAi = () => {
    lightHaptic();
    rememberRecent(debounced);
    dismiss();
    navigation.navigate(ROUTES.APP.ASK_AI as never, { groupId: aiGroupId, initialQuestion: debounced } as never);
  };

  const fieldBg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)';
  const selectedChipBg = isDark ? 'rgba(88,166,255,0.24)' : 'rgba(0,122,255,0.14)';
  const suggestions = useMemo(() => {
    const dynamic = getSuggestions(selectedScope);
    return dynamic.length > 0 ? dynamic : FALLBACK_SUGGESTIONS[selectedScope];
  }, [getSuggestions, selectedScope]);
  // Predictive completions: a few candidates that CONTINUE what's been typed, so
  // people rarely have to finish the query. Drawn from real signal (past searches,
  // live suggestions, top result titles) so they always correspond to the input.
  // Capped at 3 so actual results stay the prominent thing on screen.
  const predictions = useMemo(() => {
    const q = debounced.toLowerCase();
    if (q.length < 1) return [];
    const pool = Array.from(
      new Set([...recents, ...getSuggestions(selectedScope), ...results.slice(0, 8).map((r) => r.title)]),
    );
    return pool
      .filter((c) => {
        const lc = c.toLowerCase();
        return lc.startsWith(q) && lc !== q;
      })
      .slice(0, 3);
  }, [debounced, recents, getSuggestions, selectedScope, results]);

  const scopeOptions = useMemo<AppSearchScope[]>(
    () => ([defaultScope, 'all', 'expenses', 'chat', 'calls', 'settings'] as AppSearchScope[])
      .filter((scope, index, arr) => arr.indexOf(scope) === index),
    [defaultScope],
  );

  return (
    // Reads as a layer, not a page: no heading, content hugging the bottom, and the
    // app's own liquid background behind it (search is a tab, so the previous tab's
    // content can't literally show through — see the SEARCH_TAB notes in AppNavigator).
    // The field is pinned to the BOTTOM and rides up over the keyboard: the ergonomic
    // spot, and where the eye already is.
    <LiquidBackground>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close search"
        style={styles.scrim}
        onPress={dismiss}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlayBody}
        pointerEvents="box-none"
      >
        {/* Results grow UPWARD from the field. */}
        <ScrollView
          style={styles.results}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.resultsContent}
          showsVerticalScrollIndicator={false}
        >
          {debounced.length === 0 ? (
            <View>
              {recents.length > 0 && (
                <View style={styles.block}>
                  <View style={styles.sectionHeader}>
                    <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant, marginBottom: 0 }]}>
                      Recent
                    </Text>
                    <TouchableOpacity onPress={clearAllRecents} accessibilityRole="button" accessibilityLabel="Clear all recent searches">
                      <Text variant="labelMedium" style={{ color: theme.colors.primary }}>Clear all</Text>
                    </TouchableOpacity>
                  </View>
                  <GlassCard style={styles.recentsCard}>
                    {recents.map((r) => (
                      <RecentRow
                        key={r}
                        value={r}
                        onPress={() => {
                          selectionHaptic();
                          setQuery(r);
                        }}
                        onRemove={() => removeRecent(r)}
                      />
                    ))}
                  </GlassCard>
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
              {/* Predictive completions — the typed part renders in the normal text
                  colour and the completion in the muted one, so it's obvious what
                  you wrote vs what we're offering. */}
              {predictions.length > 0 && (
                <GlassCard style={styles.card}>
                  {predictions.map((p) => (
                    <TouchableOpacity
                      key={p}
                      onPress={() => {
                        selectionHaptic();
                        setQuery(p);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={p}
                      style={styles.predictRow}
                    >
                      <Ionicons name="search" size={15} color={theme.colors.onSurfaceVariant} />
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: theme.typography.body.fontSize }}>
                        <Text style={{ color: theme.colors.onSurface }}>{p.slice(0, debounced.length)}</Text>
                        <Text style={{ color: theme.colors.onSurfaceVariant }}>{p.slice(debounced.length)}</Text>
                      </Text>
                      <Ionicons name="arrow-up-outline" size={14} color={theme.colors.muted} style={styles.predictArrow} />
                    </TouchableOpacity>
                  ))}
                </GlassCard>
              )}

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

              {/* Never leave a blank view: symbol + title + a subtitle that echoes the
                  query back, so a typo is obvious and it's clear search actually ran. */}
              {sections.length === 0 && !showAiCard && (
                <View style={styles.empty}>
                  <Ionicons name="search-outline" size={40} color={theme.colors.onSurfaceVariant} />
                  <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    No Results
                  </Text>
                  <Text style={[styles.emptySubtitle, { color: theme.colors.onSurfaceVariant }]}>
                    No {SCOPE_LABELS[selectedScope].toLowerCase()} match “{debounced}”. Check the spelling or try a new search.
                  </Text>
                </View>
              )}

              {sections.map((section) => (
                <GlassCard key={section.type} style={styles.card}>
                  <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant, paddingHorizontal: 4 }]}>
                    {SECTION_LABELS[section.type]}
                  </Text>
                  {section.items.map((item) => (
                    <ResultRow key={item.id} item={item} query={debounced} onPress={() => open(item)} />
                  ))}
                </GlassCard>
              ))}
            </View>
          )}
        </ScrollView>

        {/* Bottom bar: scopes + field + the big X, all riding above the keyboard. */}
        <View
          style={[
            styles.bottomBar,
            { paddingBottom: keyboardUp ? 10 : getFloatingTabBarEnvelopeHeight(insets.bottom) + 8 },
          ]}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scopeRow}
          >
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
                    {SCOPE_LABELS[scope]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.fieldRow}>
            <View style={[styles.field, { backgroundColor: fieldBg, flex: 1 }]}>
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
            {/* The big X — closes the overlay and drops the user back where they were. */}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Close search"
              onPress={dismiss}
              style={[styles.closeButton, { backgroundColor: fieldBg }]}
            >
              <Ionicons name="close" size={22} color={theme.colors.onSurface} />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  // Overlay shell — transparent so the tab underneath shows through.
  overlayRoot: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFillObject },
  overlayBody: { flex: 1, justifyContent: 'flex-end' },
  // flexGrow:0 + flexShrink:1 => results hug the field and grow upward, never
  // pushing it off screen.
  results: { flexGrow: 0, flexShrink: 1 },
  resultsContent: { paddingHorizontal: 16, paddingTop: 8 },
  bottomBar: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  recentsCard: { paddingVertical: 2, paddingHorizontal: 0, overflow: 'hidden' },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12 },
  recentDelete: { width: 64, alignItems: 'center', justifyContent: 'center' },
  predictRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 8 },
  predictArrow: { transform: [{ rotate: '-45deg' }] },
  emptySubtitle: { textAlign: 'center', paddingHorizontal: 24, lineHeight: 19 },
  scopeRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  scopeChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 15 },
  block: { marginTop: 10 },
  sectionLabel: { letterSpacing: 0.5, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  card: { paddingVertical: 6, paddingHorizontal: 8, gap: 2 },
  aiCard: { paddingVertical: 4, paddingHorizontal: 8 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 48 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4 },
  resultIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  resultCopy: { flex: 1 },
});
