/**
 * AiEvalsScreen — the quality flywheel's replay harness (doc 25 Q1).
 *
 * Every 👎 in an AI chat lands here as a fixture. "Run all" replays each one
 * through the LIVE pipeline with its original facts + conversation tail and
 * grades the doc-25 invariants (reply produced, numbers grounded, local-pin
 * honored, clarify shape). Old-vs-new replies render side by side — the
 * automated verdict covers what machines can check; the diff is for you.
 *
 * The doc-24 P6 tail (flag + legacy fallbacks) drops once this suite runs
 * clean on the physical iPhone. Reached from Settings → On-Device AI.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import {
  deleteFixture,
  getEvalStatus,
  listFixtures,
  replayFixture,
  setEvalStatus,
  type EvalStatus,
} from '@/services/aiFeedbackService';
import { getOnDeviceAiAvailability } from '@/services/onDeviceAiService';
import { FEEDBACK_REASON_LABELS, type AiFixture } from '@/utils/aiFeedback';
import { lightHaptic, mediumHaptic, successHaptic } from '@/utils/haptics';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const AiEvalsScreen = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { groups } = useGroups();
  const [fixtures, setFixtures] = useState<AiFixture[]>([]);
  const [status, setStatus] = useState<EvalStatus | null>(null);
  const [running, setRunning] = useState<string | null>(null); // "3/12" progress
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setFixtures(await listFixtures());
    setStatus(await getEvalStatus());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAll = async () => {
    if (running || fixtures.length === 0 || !user) return;
    mediumHaptic();
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < fixtures.length; i++) {
      setRunning(`${i + 1}/${fixtures.length}`);
      const fixture = fixtures[i];
      const group = groups?.find((g) => g.groupId === fixture.trace.scope);
      // Replays run sequentially — every model call already rides serializeFm.
      const run = await replayFixture(fixture, {
        group,
        currentUserId: user.userId,
        personalGroups: groups ?? [],
      });
      if (run.skipped) skipped += 1;
      else if (run.pass) passed += 1;
      else failed += 1;
    }
    const summary: EvalStatus = { at: Date.now(), total: fixtures.length, passed, failed, skipped };
    await setEvalStatus(summary);
    setRunning(null);
    successHaptic();
    await reload();
  };

  const removeFixture = async (id: string) => {
    lightHaptic();
    await deleteFixture(id);
    await reload();
  };

  const modelReady = getOnDeviceAiAvailability() === 'available';
  const green = '#22c55e';
  const red = '#ef4444';

  const verdictChip = (f: AiFixture) => {
    if (!f.lastRun) return { label: 'not run', color: theme.colors.onSurfaceVariant };
    if (f.lastRun.skipped) return { label: 'skipped', color: theme.colors.onSurfaceVariant };
    return f.lastRun.pass ? { label: 'PASS', color: green } : { label: 'FAIL', color: red };
  };

  return (
    <LiquidBackground style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content}>
        <GlassView style={styles.card}>
          <View style={styles.statusRow}>
            <Icon source="clipboard-check-outline" size={20} color={theme.colors.primary} />
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                {fixtures.length} fixture{fixtures.length === 1 ? '' : 's'} from 👎 feedback
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {status
                  ? `Last run ${shortDate(status.at)}: ${status.passed} passed · ${status.failed} failed · ${status.skipped} skipped`
                  : 'Never run on this device'}
              </Text>
            </View>
          </View>
          <Button
            mode="contained"
            onPress={() => void runAll()}
            disabled={!!running || fixtures.length === 0 || !modelReady}
            style={styles.runBtn}
          >
            {running ? `Replaying ${running}…` : modelReady ? 'Run all' : 'Model unavailable'}
          </Button>
          {status && status.failed > 0 && (
            <Text variant="bodySmall" style={{ color: red, marginTop: 6 }}>
              Reds present — fix before dropping the legacy fallbacks (doc 24 P6 tail).
            </Text>
          )}
        </GlassView>

        {fixtures.length === 0 && (
          <Text variant="bodyMedium" style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
            Nothing here yet. Thumb-down a bad AI answer in any chat and it lands here as a
            replayable fixture.
          </Text>
        )}

        {fixtures.map((f) => {
          const chip = verdictChip(f);
          const open = expanded === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              onPress={() => {
                lightHaptic();
                setExpanded(open ? null : f.id);
              }}
              accessibilityRole="button"
              accessibilityLabel="Toggle fixture detail"
            >
              <GlassView style={styles.card}>
                <View style={styles.fixtureHeader}>
                  <View style={styles.flex}>
                    <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }} numberOfLines={1}>
                      “{f.trace.userText || '(unknown question)'}”
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {shortDate(f.createdAt)}
                      {f.reason ? ` · ${FEEDBACK_REASON_LABELS[f.reason]}` : ''}
                      {f.reduced ? ' · reduced' : ''}
                      {` · ${f.trace.surface}`}
                    </Text>
                  </View>
                  <Text variant="labelSmall" style={{ color: chip.color, fontWeight: '700' }}>
                    {chip.label}
                  </Text>
                  <TouchableOpacity onPress={() => void removeFixture(f.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Delete fixture">
                    <Icon source="close" size={16} color={theme.colors.onSurfaceVariant} />
                  </TouchableOpacity>
                </View>
                {open && (
                  <View style={styles.detail}>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>THEN</Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurface }}>{f.trace.replyText}</Text>
                    {f.lastRun?.newReplyText != null && (
                      <>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>NOW</Text>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurface }}>{f.lastRun.newReplyText}</Text>
                      </>
                    )}
                    {f.lastRun?.skipped && (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                        Skipped: {f.lastRun.skipped}
                      </Text>
                    )}
                    {(f.lastRun?.verdicts ?? []).map((v) => (
                      <View key={v.check} style={styles.verdictRow}>
                        <Icon source={v.pass ? 'check-circle' : 'close-circle'} size={14} color={v.pass ? green : red} />
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurface }}>{v.check}</Text>
                        {!v.pass && v.note ? (
                          <Text variant="labelSmall" style={{ flex: 1, color: theme.colors.onSurfaceVariant }} numberOfLines={2}>
                            — {v.note}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}
              </GlassView>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Tightened 12 -> 8 (2026-08-07, compact density pass).
  content: { padding: 16, gap: 8, paddingBottom: 48 },
  card: { borderRadius: 16, padding: 14, gap: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  runBtn: { marginTop: 10 },
  empty: { textAlign: 'center', marginTop: 24, paddingHorizontal: 24 },
  fixtureHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detail: { marginTop: 10, gap: 2 },
  verdictRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
});
