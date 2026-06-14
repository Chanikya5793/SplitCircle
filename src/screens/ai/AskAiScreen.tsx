/**
 * AskAiScreen — natural-language Q&A over the group's expenses.
 *
 * Prefers Apple's ON-DEVICE Foundation Models (Apple Intelligence, iOS 26+):
 * free, private, no backend — the group's expenses are already on the phone.
 * Falls back to the cloud `askExpenseAi` callable when the device isn't
 * eligible AND the cloud AI layer is enabled. When neither is available we
 * show a precise, friendly note (e.g. "needs an iPhone 15 Pro or newer")
 * instead of an error — the rest of the app is unaffected.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import type { Group } from '@/models';
import {
  AiUnavailableError,
  askExpenseAi,
  type ExpenseAiAnswer,
} from '@/services/aiService';
import {
  answerExpenseLocally,
  askExpenseAiOnDevice,
  getOnDeviceAiAvailability,
  ON_DEVICE_UNAVAILABLE_COPY,
} from '@/services/onDeviceAiService';
import { formatCurrency } from '@/utils/currency';
import { mediumHaptic } from '@/utils/haptics';
import { useMemo, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { ActivityIndicator, Chip, Icon, Text, TextInput } from 'react-native-paper';

interface AskAiScreenProps {
  group: Group;
  /** Optional question to prefill (e.g. from a tapped Siri suggestion). */
  initialQuestion?: string;
}

const SUGGESTED_PROMPTS = [
  'How much did I spend on food?',
  'What were our biggest expenses?',
  'How much do I owe right now?',
  'Summarize last month',
];

export const AskAiScreen = ({ group, initialQuestion }: AskAiScreenProps) => {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const currentUserId = user?.userId ?? group.members[0]?.userId ?? '';
  const [question, setQuestion] = useState(initialQuestion ?? '');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<ExpenseAiAnswer | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable per-mount: Apple Intelligence eligibility doesn't change mid-screen.
  const onDeviceAvailability = useMemo(() => getOnDeviceAiAvailability(), []);
  const onDevice = onDeviceAvailability === 'available';
  // Only devices that genuinely cannot run the on-device model should reach the
  // (optional) cloud path. "Enable Apple Intelligence" and "model still
  // downloading" are actionable states on otherwise-capable hardware — we show
  // the user how to fix them rather than silently sending the question to a
  // backend they didn't opt into.
  const cloudEligible =
    onDeviceAvailability === 'deviceNotEligible' || onDeviceAvailability === 'unsupportedOS';

  const submit = async (raw?: string) => {
    const q = (raw ?? question).trim();
    if (!q || loading) return;
    Keyboard.dismiss();
    mediumHaptic();
    setQuestion(q);
    setLoading(true);
    setError(null);
    setUnavailable(null);
    setAnswer(null);
    try {
      // 1) Deterministic, exact answer for the common questions — computed
      // on-device with no model, so it's correct, instant, and works on EVERY
      // device (no Apple Intelligence needed).
      const local = answerExpenseLocally(q, group, currentUserId);
      if (local) {
        setAnswer(local);
        return;
      }
      // 2) Open-ended → on-device LLM (grounded with exact totals).
      if (onDevice) {
        setAnswer(await askExpenseAiOnDevice(q, group, currentUserId));
      } else if (cloudEligible) {
        // Device can't run on-device AI → cloud AI layer, if it's been enabled.
        setAnswer(await askExpenseAi(q, { groupId: group.groupId }));
      } else {
        // appleIntelligenceNotEnabled / modelNotReady → actionable, no network.
        setUnavailable(ON_DEVICE_UNAVAILABLE_COPY[onDeviceAvailability]);
      }
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        // Only the cloud path throws this. Reached only for ineligible/
        // unsupported devices — surface that device's specific note. If
        // on-device was available (shouldn't happen here), don't mislabel a
        // cloud outage as an OS problem — show the real error.
        if (onDeviceAvailability === 'available') {
          setError(err.message);
        } else {
          setUnavailable(ON_DEVICE_UNAVAILABLE_COPY[onDeviceAvailability]);
        }
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const confidencePct = answer ? Math.round(answer.confidence * 100) : 0;
  const lowConfidence = answer != null && answer.confidence < 0.5;

  return (
    <LiquidBackground>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <GlassView style={styles.card}>
          <View style={styles.headerRow}>
            <Icon source="robot-happy-outline" size={22} color={theme.colors.primary} />
            <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
              Ask about {group.name}
            </Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 12 }}>
            Ask anything about this group's expenses. Answers are grounded in your
            own data and cite the expenses they used.
          </Text>

          <TextInput
            mode="outlined"
            value={question}
            onChangeText={setQuestion}
            placeholder="e.g. How much did we spend on travel?"
            multiline
            maxLength={500}
            onSubmitEditing={() => submit()}
            right={
              <TextInput.Icon
                icon="send"
                disabled={loading || !question.trim()}
                onPress={() => submit()}
              />
            }
            style={{ backgroundColor: 'transparent' }}
          />

          {!answer && !loading ? (
            <View style={styles.prompts}>
              {SUGGESTED_PROMPTS.map((p) => (
                <Chip
                  key={p}
                  compact
                  onPress={() => submit(p)}
                  style={{ backgroundColor: theme.colors.secondaryContainer }}
                  textStyle={{ color: theme.colors.onSecondaryContainer }}
                >
                  {p}
                </Chip>
              ))}
            </View>
          ) : null}
        </GlassView>

        {loading ? (
          <GlassView style={styles.card}>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text style={{ color: theme.colors.onSurfaceVariant }}>Thinking…</Text>
            </View>
          </GlassView>
        ) : null}

        {unavailable ? (
          <GlassView style={styles.card}>
            <View style={styles.headerRow}>
              <Icon source="cloud-off-outline" size={20} color={theme.colors.onSurfaceVariant} />
              <Text variant="titleSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                Not available on this device
              </Text>
            </View>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {unavailable}
            </Text>
          </GlassView>
        ) : null}

        {error ? (
          <GlassView style={styles.card}>
            <Text variant="bodyMedium" style={{ color: theme.colors.error }}>{error}</Text>
          </GlassView>
        ) : null}

        {answer ? (
          <GlassView style={styles.card}>
            <View style={styles.answerHeader}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                ANSWER
              </Text>
              <Chip
                compact
                style={{
                  backgroundColor: lowConfidence
                    ? (isDark ? 'rgba(255,193,7,0.16)' : 'rgba(255,193,7,0.18)')
                    : theme.colors.secondaryContainer,
                }}
                textStyle={{ color: theme.colors.onSecondaryContainer }}
              >
                {confidencePct}% confidence
              </Chip>
            </View>

            <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
              {answer.answer}
            </Text>

            {lowConfidence ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, fontStyle: 'italic' }}>
                Low confidence — double-check against the cited expenses below.
              </Text>
            ) : null}

            {answer.sources.length > 0 ? (
              <View style={styles.sources}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 6 }}>
                  SOURCES
                </Text>
                {answer.sources.map((s, i) => (
                  <View key={`${s.expenseId}-${i}`} style={styles.sourceRow}>
                    <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                      [{i + 1}]
                    </Text>
                    <Text variant="bodySmall" style={{ flex: 1, color: theme.colors.onSurface }}>
                      {s.title ?? 'Expense'}
                      {s.category ? ` · ${s.category}` : ''}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {formatCurrency(s.amount, s.currency ?? group.currency)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            <TouchableOpacity onPress={() => { setAnswer(null); setQuestion(''); }} style={styles.askAnother}>
              <Icon source="refresh" size={16} color={theme.colors.primary} />
              <Text variant="labelLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                Ask another
              </Text>
            </TouchableOpacity>
          </GlassView>
        ) : null}

        <Text variant="bodySmall" style={[styles.disclaimer, { color: theme.colors.onSurfaceVariant }]}>
          {onDevice
            ? 'Powered by Apple Intelligence — answers are generated entirely on your iPhone and your data never leaves the device. AI answers can be imperfect.'
            : "AI answers can be imperfect. Your question is scrubbed of contact details on-device before it's sent."}
        </Text>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 18,
    padding: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  prompts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  answerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sources: {
    marginTop: 14,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  askAnother: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    alignSelf: 'flex-start',
  },
  disclaimer: {
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: 12,
  },
});

export default AskAiScreen;
