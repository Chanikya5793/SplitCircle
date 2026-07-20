/**
 * AiMemoryScreen — the AI memory ledger (doc 25 Q2, Settings → On-Device AI).
 *
 * Full-transparency contract (locked): every remembered item is shown VERBATIM
 * with its provenance, deletable one by one; each memory kind has a master
 * switch; patterns show why they exist ("asked 6×"); one button wipes it all.
 * Storage is Local-tier AsyncStorage — nothing here ever touches Firestore.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import {
  deleteItem,
  deletePattern,
  getToggles,
  listLedger,
  listScopes,
  setToggle,
  wipeAll,
} from '@/services/aiMemoryService';
import { DEFAULT_TOGGLES, type MemoryItem, type MemoryKind, type MemoryToggles } from '@/utils/aiMemory';
import { lightHaptic, mediumHaptic } from '@/utils/haptics';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Switch, Text } from 'react-native-paper';

interface LedgerRow extends MemoryItem {
  scope: string;
}

interface PatternRow {
  scope: string;
  key: string;
  text: string;
  provenance: string;
}

const KIND_META: Record<MemoryKind, { title: string; icon: string; hint: string }> = {
  preference: { title: 'Preferences', icon: 'tune', hint: 'Standing asks that steer every answer.' },
  entityFix: { title: 'Name fixes', icon: 'account-check-outline', hint: 'Learned from your clarification picks.' },
  fact: { title: 'Facts & nicknames', icon: 'lightbulb-outline', hint: 'Things you told it to remember.' },
  pattern: { title: 'Observed patterns', icon: 'chart-timeline-variant', hint: 'Computed from usage — never written by the model.' },
};

/** Human label for a memory scope key. */
const scopeLabel = (scope: string, groupName: (id: string) => string): string => {
  if (scope === 'global') return 'Everywhere';
  if (scope === 'personal') return 'Personal stats';
  return groupName(scope.replace(/^group:/, ''));
};

export const AiMemoryScreen = () => {
  const { theme } = useTheme();
  const { groups } = useGroups();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [toggles, setToggles] = useState<MemoryToggles>(DEFAULT_TOGGLES);

  const groupName = useCallback(
    (id: string): string => groups?.find((g) => g.groupId === id)?.name ?? 'a former group',
    [groups],
  );

  const refresh = useCallback(async () => {
    const scopes = [...new Set(['global', ...(await listScopes())])];
    const ledgers = await Promise.all(scopes.map(async (scope) => ({ scope, ...(await listLedger(scope)) })));
    setRows(ledgers.flatMap((l) => l.items.map((i) => ({ ...i, scope: l.scope }))));
    setPatterns(ledgers.flatMap((l) => l.patterns.map((p) => ({ ...p, scope: l.scope }))));
    setToggles(await getToggles());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flip = async (kind: MemoryKind) => {
    lightHaptic();
    await setToggle(kind, !toggles[kind]);
    await refresh();
  };

  const removeItem = async (row: LedgerRow) => {
    lightHaptic();
    await deleteItem(row.scope, row.id);
    await refresh();
  };

  const removePattern = async (row: PatternRow) => {
    lightHaptic();
    await deletePattern(row.scope, row.key);
    await refresh();
  };

  const wipe = async () => {
    mediumHaptic();
    await wipeAll();
    await refresh();
  };

  const section = (kind: MemoryKind) => {
    const meta = KIND_META[kind];
    const sectionRows = rows.filter((r) => r.kind === kind);
    return (
      <GlassView key={kind} style={styles.card}>
        <View style={styles.sectionHeader}>
          <Icon source={meta.icon} size={18} color={theme.colors.primary} />
          <View style={styles.sectionTitle}>
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {meta.title}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {meta.hint}
            </Text>
          </View>
          <Switch value={toggles[kind]} onValueChange={() => void flip(kind)} trackColor={{ true: theme.colors.primary }} />
        </View>
        {kind === 'pattern' ? (
          patterns.length === 0 ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Nothing observed yet.
            </Text>
          ) : (
            patterns.map((p) => (
              <View key={`${p.scope}:${p.key}`} style={styles.row}>
                <View style={styles.rowBody}>
                  <Text style={{ color: theme.colors.onSurface }}>{p.text}</Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {p.provenance} · {scopeLabel(p.scope, groupName)}
                  </Text>
                </View>
                <IconButton icon="close" size={16} onPress={() => void removePattern(p)} accessibilityLabel={`Forget ${p.text}`} />
              </View>
            ))
          )
        ) : sectionRows.length === 0 ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {kind === 'entityFix' ? 'Nothing learned yet.' : 'Nothing remembered yet — say "remember that …" in a chat.'}
          </Text>
        ) : (
          sectionRows.map((r) => (
            <View key={r.id} style={styles.row}>
              <View style={styles.rowBody}>
                <Text style={{ color: theme.colors.onSurface }}>{r.text}</Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {r.provenance ?? ''} · {scopeLabel(r.scope, groupName)}
                </Text>
              </View>
              <IconButton icon="close" size={16} onPress={() => void removeItem(r)} accessibilityLabel={`Forget ${r.text}`} />
            </View>
          ))
        )}
      </GlassView>
    );
  };

  return (
    <LiquidBackground style={styles.flex}>
      <GuardedScreen target="expenses" label="AI memory hidden">
        <ScrollView contentContainerStyle={styles.content}>
          <GlassView style={styles.card}>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
              Everything the AI remembers, verbatim. It lives only on this phone, steers answers on
              every surface, and each line can be deleted. Nothing here is ever uploaded to
              SplitCircle's servers.
            </Text>
          </GlassView>
          {(['preference', 'entityFix', 'fact', 'pattern'] as MemoryKind[]).map(section)}
          <Button
            mode="outlined"
            icon="delete-outline"
            onPress={() => void wipe()}
            textColor={theme.colors.error}
            style={{ marginTop: 8, borderColor: theme.colors.error }}
          >
            Forget everything
          </Button>
        </ScrollView>
      </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  card: { borderRadius: 16, padding: 14 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  sectionTitle: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  rowBody: { flex: 1 },
});
