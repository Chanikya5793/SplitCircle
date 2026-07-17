// App-wide search — a single place to find any group, expense, person, chat,
// call or setting. Runs entirely on-device: the index is built from live memory
// (see useAppSearch) and ranked locally, so results are instant. Natural-language
// questions surface an on-device AI answer card grounded in the best-matching
// group. Reachable from the native iOS 26 search tab.
//
// The UI mirrors the iOS 26 Phone/Photos search pattern: a large "Search" title
// with recents + suggestion pills while idle (Photos), plain full-bleed result
// sections while typing (Phone).
//
// THE FIELD ITSELF has two modes:
// - NATIVE (iOS 26 builds carrying the react-native-screens UISearchTab patch):
//   the tab bar itself morphs into the REAL system search field (UIKit runs the
//   Liquid Glass animation). This screen renders no field at all — it mirrors
//   the native field's text via the splitcircle-ai bridge events and only draws
//   content. Cancelling natively returns to the previous tab (system behavior).
// - FALLBACK (Android / older builds): a JS bottom-docked field that fakes the
//   morph — the pill stretches out of the tab bar's search button while the
//   keyboard rises, and collapses back on dismiss.
//
// Reopen semantics (measured off Photos): switching tabs away and back KEEPS a
// committed search; only cancelling (native Cancel / the fallback X) clears it.

import { LiquidBackground } from '@/components/LiquidBackground';
import { getFloatingTabBarEnvelopeHeight } from '@/components/tabbar/tabBarMetrics';
import { GlassCard, ListRow } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useTheme } from '@/context/ThemeContext';
import { useAppSearch } from '@/hooks/useAppSearch';
import { groupByType, highlightSegments, looksLikeQuestion, SECTION_LABELS, type RankedItem } from '@/services/searchService';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import {
  isNativeSearchTabAvailable,
  setNativeSearchTabText,
  subscribeNativeSearchTab,
} from '../../../modules/splitcircle-ai';
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
  useWindowDimensions,
  View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const RECENTS_KEY = 'search_recents_v1';

// Morph choreography, measured off the Phone app at 60fps: the circle-to-field
// stretch runs ~18 frames (~300ms) with a strong ease-out, the keyboard rising
// in parallel; content fades in slightly behind the field. Dismiss reverses it.
const MORPH_IN_MS = 320;
const MORPH_OUT_MS = 240;
const CONTENT_IN_MS = 260;

// Fallback "try this" pills, used only until (or when) the user has no real
// data to draw dynamic suggestions from. See useAppSearch.getSuggestions.
const FALLBACK_SUGGESTIONS = ['Dinner', 'notifications', 'missed call', 'AI index'];

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

// Plain full-bleed result row (Phone-app style): icon circle, highlighted
// title/subtitle, hairline divider drawn by the section that owns it.
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
// affordance Apple asks for on recents (alongside "Clear" in the section
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
  const { theme, isDark } = useTheme();
  const rowBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
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
        style={[styles.recentRow, { backgroundColor: rowBg }]}
      >
        <Ionicons name="time-outline" size={16} color={theme.colors.onSurfaceVariant} />
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.onSurface }}>
          {value}
        </Text>
        <Ionicons name="arrow-up-outline" size={14} color={theme.colors.muted} style={styles.recentArrow} />
      </TouchableOpacity>
    </ReanimatedSwipeable>
  );
};

export const SearchScreen = () => {
  const navigation = useNavigation<any>();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { search, firstSearchableGroupId, getSuggestions } = useAppSearch();

  // Native mode: the system UISearchTab field in the tab bar is the input; this
  // screen only mirrors it. Fallback mode: this screen owns a JS field.
  const nativeMode = useMemo(() => isNativeSearchTabAvailable(), []);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const inputRef = useRef<TextInput>(null);

  // The tab bar sits over the bottom of this screen, so the field must clear it when
  // idle — but once the keyboard is up it covers the tab bar, and that same padding
  // would leave the field floating in a gap. Track the keyboard and swap.
  const [keyboardUp, setKeyboardUp] = useState(false);

  // ── Open/close morph ──────────────────────────────────────────────────────
  // 0 = a 44pt circle hugging the right edge (where the tab bar's search button
  // lives), 1 = the full-width field with the round X beside it. The field row
  // is right-justified so width growth stretches LEFTWARD, like the real morph.
  const morph = useSharedValue(0);
  const contentIn = useSharedValue(0);

  const FIELD_HEIGHT = 44;
  const CLOSE_SIZE = 40;
  const CLOSE_GAP = 10;
  // Full field width once the X and paddings are accounted for.
  const fieldMaxWidth = windowWidth - 16 * 2 - CLOSE_SIZE - CLOSE_GAP;

  const fieldMorphStyle = useAnimatedStyle(() => ({
    width: interpolate(morph.value, [0, 1], [FIELD_HEIGHT, fieldMaxWidth]),
  }));
  // Placeholder/icon/input fade in only once the pill has mostly stretched.
  const fieldInnerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(morph.value, [0.45, 1], [0, 1], 'clamp'),
  }));
  // The X pops in at the tail of the morph, in the spot the circle started from.
  const closeStyle = useAnimatedStyle(() => ({
    width: interpolate(morph.value, [0, 1], [0, CLOSE_SIZE]),
    marginLeft: interpolate(morph.value, [0, 1], [0, CLOSE_GAP]),
    opacity: interpolate(morph.value, [0.55, 1], [0, 1], 'clamp'),
    transform: [{ scale: interpolate(morph.value, [0.55, 1], [0.6, 1], 'clamp') }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentIn.value,
    transform: [{ translateY: interpolate(contentIn.value, [0, 1], [10, 0]) }],
  }));

  useEffect(() => {
    void AsyncStorage.getItem(RECENTS_KEY).then((raw) => {
      if (raw) try { setRecents(JSON.parse(raw)); } catch { /* ignore */ }
    });
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
      contentIn.value = 0;
      contentIn.value = withDelay(90, withTiming(1, { duration: CONTENT_IN_MS }));
      if (nativeMode) {
        // UIKit runs the real tab-bar → field morph and focuses the field itself.
        morph.value = 1;
        return;
      }
      morph.value = 0;
      morph.value = withTiming(1, { duration: MORPH_IN_MS, easing: Easing.out(Easing.cubic) });
      // Focus almost immediately so the keyboard rises IN PARALLEL with the
      // stretch, exactly like the native morph — not after it.
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      // NOTE: the query deliberately survives losing focus — switching tabs away
      // and back keeps a committed search (Photos). Only cancel/X clears it.
      return () => clearTimeout(t);
    }, [contentIn, morph, nativeMode]),
  );

  const results = useMemo(() => (debounced ? search(debounced, 'all') : []), [debounced, search]);
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

  // Functional update: also called from the long-lived native-event subscription,
  // where a closure over `recents` would be stale.
  const rememberRecent = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    setRecents((prev) => {
      const next = [trimmed, ...prev.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())].slice(0, 8);
      void AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Mirror the native tab-bar search field (UISearchTab) into this screen.
  useEffect(() => {
    if (!nativeMode) return;
    return subscribeNativeSearchTab((event) => {
      switch (event.type) {
        case 'textChange':
          setQuery(event.text);
          break;
        case 'submit':
          rememberRecent(event.text);
          break;
        case 'deactivate':
          // The user cancelled the search session (native Cancel/X): Photos
          // clears the query here, so the tab reopens fresh next time.
          setQuery('');
          setDebounced('');
          break;
        default:
          break;
      }
    });
  }, [nativeMode, rememberRecent]);

  const removeRecent = (value: string) => {
    selectionHaptic();
    persistRecents(recents.filter((r) => r !== value));
  };

  const clearAllRecents = () => {
    lightHaptic();
    persistRecents([]);
  };

  /**
   * Put the user back on the tab they came from. Search lives as a tab (a native
   * tab press can't be intercepted, and navigating a tab pops any modal — see the
   * notes on the SEARCH_TAB screen), so there's usually nothing to `goBack` to:
   * we walk the tab navigator's history instead.
   */
  const navBack = useCallback(() => {
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

  // Animated dismiss (fallback X = the cancel affordance): keyboard drops while
  // the field collapses back into the circle it was born from, the query clears
  // (cancel ends the search session, Photos semantics), then we leave the tab.
  const clearAndNavBack = useCallback(() => {
    setQuery('');
    setDebounced('');
    navBack();
  }, [navBack]);

  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    contentIn.value = withTiming(0, { duration: 150 });
    morph.value = withTiming(
      0,
      { duration: MORPH_OUT_MS, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(clearAndNavBack)();
      },
    );
  }, [clearAndNavBack, contentIn, morph]);

  // Route query changes from taps (recents / suggestions / predictions) through
  // the native field when it owns the input, so field and results stay in sync.
  const applyQuery = useCallback(
    (text: string) => {
      setQuery(text);
      if (nativeMode) setNativeSearchTabText(text);
    },
    [nativeMode],
  );

  // Opening a result must be instant — close the overlay synchronously BEFORE
  // navigating (no reverse morph), otherwise it stays alive underneath the
  // destination and reappears when the user comes back.
  const open = (item: RankedItem) => {
    selectionHaptic();
    rememberRecent(debounced);
    Keyboard.dismiss();
    navBack();
    navigation.navigate(item.route as never, (item.params ?? {}) as never);
  };

  const askAi = () => {
    lightHaptic();
    rememberRecent(debounced);
    Keyboard.dismiss();
    navBack();
    navigation.navigate(ROUTES.APP.ASK_AI as never, { groupId: aiGroupId, initialQuestion: debounced } as never);
  };

  const fieldBg = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)';
  const hairline = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)';
  const panelBg = isDark ? 'rgba(44,48,58,0.96)' : 'rgba(248,248,250,0.97)';
  const suggestions = useMemo(() => {
    const dynamic = getSuggestions('all');
    return dynamic.length > 0 ? dynamic : FALLBACK_SUGGESTIONS;
  }, [getSuggestions]);
  // Predictive completions: a few candidates that CONTINUE what's been typed, so
  // people rarely have to finish the query. Drawn from real signal (past searches,
  // live suggestions, top result titles) so they always correspond to the input.
  // Shown Photos-style: a compact panel FLOATING just above the field.
  const predictions = useMemo(() => {
    const q = debounced.toLowerCase();
    if (q.length < 1) return [];
    const pool = Array.from(
      new Set([...recents, ...getSuggestions('all'), ...results.slice(0, 8).map((r) => r.title)]),
    );
    return pool
      .filter((c) => {
        const lc = c.toLowerCase();
        return lc.startsWith(q) && lc !== q;
      })
      .slice(0, 3);
  }, [debounced, recents, getSuggestions, results]);

  return (
    <LiquidBackground>
      {!nativeMode && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close search"
          style={styles.scrim}
          onPress={dismiss}
        />
      )}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
        pointerEvents="box-none"
      >
        {/* Content anchored at the TOP (Photos/Phone): large title while idle,
            plain result sections while typing. */}
        <Animated.View style={[styles.content, contentStyle]}>
          <ScrollView
            style={styles.scroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={[
              styles.scrollContent,
              {
                paddingTop: insets.top + 12,
                // Native mode has no JS bottom bar below the scroll view — pad the
                // content itself past the tab bar / integrated search field.
                paddingBottom: nativeMode ? getFloatingTabBarEnvelopeHeight(insets.bottom) + 16 : 12,
              },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {debounced.length === 0 ? (
              <View>
                <Text
                  style={[
                    styles.largeTitle,
                    { color: theme.colors.onSurface, fontSize: theme.typography.display.fontSize },
                  ]}
                >
                  Search
                </Text>

                {recents.length > 0 && (
                  <View style={styles.block}>
                    <View style={styles.sectionHeader}>
                      <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                        Recents
                      </Text>
                      <TouchableOpacity
                        onPress={clearAllRecents}
                        accessibilityRole="button"
                        accessibilityLabel="Clear all recent searches"
                        style={[styles.clearPill, { backgroundColor: fieldBg }]}
                      >
                        <Text variant="labelMedium" style={{ color: theme.colors.primary }}>Clear</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={[styles.recentsList, { borderRadius: theme.radius.lg }]}>
                      {recents.map((r, i) => (
                        <View key={r} style={i < recents.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline } : null}>
                          <RecentRow
                            value={r}
                            onPress={() => {
                              selectionHaptic();
                              applyQuery(r);
                            }}
                            onRemove={() => removeRecent(r)}
                          />
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                {/* Suggestion pills, stacked vertically like Photos ("One Year
                    Ago", "Trips in 2025"...). No header — they explain themselves. */}
                <View style={[styles.block, styles.suggestionStack]}>
                  {suggestions.map((s) => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.suggestionPill, { backgroundColor: fieldBg }]}
                      onPress={() => applyQuery(s)}
                      accessibilityRole="button"
                      accessibilityLabel={`Search for ${s}`}
                    >
                      <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : (
              <View style={styles.resultsArea}>
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
                      Nothing matches “{debounced}”. Check the spelling or try a new search.
                    </Text>
                  </View>
                )}

                {/* Plain full-bleed sections (Phone app): header, rows, hairlines. */}
                {sections.map((section) => (
                  <View key={section.type} style={styles.section}>
                    <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                      {SECTION_LABELS[section.type]}
                    </Text>
                    {section.items.map((item, i) => (
                      <View
                        key={item.id}
                        style={i < section.items.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline } : null}
                      >
                        <ResultRow item={item} query={debounced} onPress={() => open(item)} />
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </Animated.View>

        {/* Predictive completions float just above the field (Photos style),
            left-anchored and self-sized — the typed part in the normal text
            colour, the completion in the muted one. */}
        {predictions.length > 0 && debounced.length > 0 && (
          <View
            style={[
              styles.predictWrap,
              // Native mode has no JS bottom bar below this panel — clear the
              // system search field: it docks at the tab bar when the keyboard
              // is down and rides on top of the keyboard when it's up.
              nativeMode && {
                paddingBottom: keyboardUp ? 64 : getFloatingTabBarEnvelopeHeight(insets.bottom) + 8,
              },
            ]}
            pointerEvents="box-none"
          >
            <View style={[styles.predictPanel, { backgroundColor: panelBg, borderColor: hairline }]}>
              {predictions.map((p, i) => (
                <TouchableOpacity
                  key={p}
                  onPress={() => {
                    selectionHaptic();
                    applyQuery(p);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={p}
                  style={[
                    styles.predictRow,
                    i < predictions.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline } : null,
                  ]}
                >
                  <Ionicons name="search" size={14} color={theme.colors.onSurfaceVariant} />
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: theme.typography.body.fontSize }}>
                    <Text style={{ color: theme.colors.onSurface }}>{p.slice(0, debounced.length)}</Text>
                    <Text style={{ color: theme.colors.onSurfaceVariant }}>{p.slice(debounced.length)}</Text>
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Fallback bottom bar: the morphing JS field + round X, riding above the
            keyboard. In native mode the system field lives in the tab bar itself. */}
        {!nativeMode && (
        <View
          style={[
            styles.bottomBar,
            { paddingBottom: keyboardUp ? 10 : getFloatingTabBarEnvelopeHeight(insets.bottom) + 8 },
          ]}
        >
          <Animated.View style={[styles.field, { backgroundColor: fieldBg }, fieldMorphStyle]}>
            <Animated.View style={[styles.fieldInner, fieldInnerStyle]}>
              <Ionicons name="search" size={18} color={theme.colors.onSurfaceVariant} />
              <TextInput
                ref={inputRef}
                value={query}
                onChangeText={setQuery}
                placeholder="Search"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                style={[styles.input, { color: theme.colors.onSurface }]}
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={() => {
                  // Committing a search (Photos): keyboard drops, results stay.
                  rememberRecent(debounced);
                  Keyboard.dismiss();
                }}
              />
              {query.length > 0 && (
                <TouchableOpacity onPress={() => setQuery('')} accessibilityLabel="Clear">
                  <Ionicons name="close-circle" size={18} color={theme.colors.onSurfaceVariant} />
                </TouchableOpacity>
              )}
            </Animated.View>
          </Animated.View>
          {/* The round X — closes search and drops the user back where they were.
              Both Phone and Photos keep this beside the docked field. */}
          <Animated.View style={closeStyle}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Close search"
              onPress={dismiss}
              style={[styles.closeButton, { backgroundColor: fieldBg }]}
            >
              <Ionicons name="close" size={22} color={theme.colors.onSurface} />
            </TouchableOpacity>
          </Animated.View>
        </View>
        )}
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  body: { flex: 1 },
  content: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 12 },
  largeTitle: { fontWeight: '700', marginBottom: 4 },
  // Bottom bar right-justified: the field grows LEFTWARD from the circle.
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  field: {
    borderRadius: 22,
    height: 44,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fieldInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: { marginTop: 18 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  clearPill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 },
  recentsList: { overflow: 'hidden' },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12 },
  recentArrow: { transform: [{ rotate: '-45deg' }] },
  recentDelete: { width: 64, alignItems: 'center', justifyContent: 'center' },
  suggestionStack: { alignItems: 'flex-start', gap: 10 },
  suggestionPill: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
  predictWrap: { paddingHorizontal: 16, paddingBottom: 6, alignItems: 'flex-start' },
  predictPanel: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 200,
    maxWidth: '78%',
    overflow: 'hidden',
  },
  predictRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12 },
  resultsArea: { gap: 4, paddingTop: 8 },
  section: { marginBottom: 14 },
  sectionTitle: { fontWeight: '600', marginBottom: 2 },
  aiCard: { paddingVertical: 4, paddingHorizontal: 8, marginBottom: 10 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 48 },
  emptySubtitle: { textAlign: 'center', paddingHorizontal: 24, lineHeight: 19 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 2 },
  resultIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  resultCopy: { flex: 1 },
});
