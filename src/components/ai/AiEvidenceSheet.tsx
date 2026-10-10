import { GlassView } from '@/components/GlassView';
import { ScrimBackdrop } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { AiToolEvidence } from '@/utils/aiTools';
import type { AiAnswerSource, AiThreadSource } from '@/utils/aiThreads';
import { formatCurrency } from '@/utils/currency';
import { lightHaptic } from '@/utils/haptics';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Animated, { SlideInDown } from 'react-native-reanimated';

interface AiEvidenceSheetProps {
  engine?: AiAnswerSource;
  capabilities?: AiToolEvidence[];
  sources?: AiThreadSource[];
  fallbackCurrency?: string;
  onOpenExpense?: (source: AiThreadSource) => void;
}

const ENGINE: Record<AiAnswerSource, { icon: string; label: string; detail: string }> = {
  deterministic: {
    icon: 'calculator-variant-outline',
    label: 'Exact calculation',
    detail: 'ManaSplit calculated this answer directly from your expense and balance data.',
  },
  ondevice: {
    icon: 'chip',
    label: 'On-device',
    detail: 'ManaSplit gathered the relevant data, then Apple Intelligence wrote the answer on this device.',
  },
  pcc: {
    icon: 'cloud-lock-outline',
    label: 'Private Cloud',
    detail: 'ManaSplit gathered the relevant data, then Apple Private Cloud Compute wrote the answer.',
  },
};

const DATA_CLASS: Record<string, string> = {
  persistent_money: 'Expense and balance data',
  local_chat: 'Messages stored on this device',
  local_calls: 'Call history stored on this device',
};

export const AiEvidenceSheet = ({
  engine,
  capabilities = [],
  sources = [],
  fallbackCurrency = 'USD',
  onOpenExpense,
}: AiEvidenceSheetProps) => {
  const { theme } = useTheme();
  const [visible, setVisible] = useState(false);
  if (!engine && capabilities.length === 0 && sources.length === 0) return null;

  const engineInfo = engine ? ENGINE[engine] : null;
  const close = () => setVisible(false);

  return (
    <>
      <TouchableOpacity
        onPress={() => { lightHaptic(); setVisible(true); }}
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel="How this answer was produced"
      >
        <Icon source={engineInfo?.icon ?? 'information-outline'} size={12} color={theme.colors.onSurfaceVariant} />
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, fontSize: 10 }}>
          {engineInfo ? `${engineInfo.label} · How this was answered` : 'How this was answered'}
        </Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={close}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Close answer details">
            <ScrimBackdrop pointerEvents="none" />
          </Pressable>
          {visible ? (
          <Animated.View entering={SlideInDown.springify().damping(30).stiffness(350)} accessibilityViewIsModal>
          <GlassView role="floating" style={styles.sheet}>
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  How this was answered
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                  See what data ManaSplit used and where the answer was written.
                </Text>
              </View>
              <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close answer details" style={styles.closeButton}>
                <Icon source="close" size={22} color={theme.colors.onSurfaceVariant} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.content}>
              {engineInfo ? (
                <View style={[styles.section, { borderColor: theme.colors.outlineVariant }]}>
                  <View style={styles.sectionTitle}>
                    <Icon source={engineInfo.icon} size={18} color={theme.colors.primary} />
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                      {engineInfo.label}
                    </Text>
                  </View>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
                    {engineInfo.detail}
                  </Text>
                </View>
              ) : null}

              {capabilities.length > 0 ? (
                <View style={[styles.section, { borderColor: theme.colors.outlineVariant }]}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                    Data used
                  </Text>
                  {capabilities.map((entry) => (
                    <View key={`${entry.tool}:${entry.version}`} style={styles.detailRow}>
                      <Icon source="check-circle-outline" size={16} color={theme.colors.primary} />
                      <View style={{ flex: 1 }}>
                        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>{entry.title}</Text>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          {entry.dataClasses.map((kind) => DATA_CLASS[kind] ?? kind).join(' · ')}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              {sources.length > 0 ? (
                <View style={[styles.section, { borderColor: theme.colors.outlineVariant }]}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                    Expenses used
                  </Text>
                  {sources.map((source, index) => {
                    const canOpen = Boolean(source.expenseId && onOpenExpense);
                    const rowContent = (
                      <>
                      <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                        [{index + 1}]
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }} numberOfLines={1}>
                          {source.title ?? 'Expense'}
                        </Text>
                        {source.category ? (
                          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{source.category}</Text>
                        ) : null}
                      </View>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {formatCurrency(source.amount, source.currency ?? fallbackCurrency)}
                      </Text>
                      {canOpen ? (
                        <Icon source="chevron-right" size={16} color={theme.colors.onSurfaceVariant} />
                      ) : null}
                      </>
                    );
                    const key = `${source.expenseId ?? source.title ?? 'source'}:${index}`;
                    return canOpen ? (
                      <TouchableOpacity
                        key={key}
                        style={styles.detailRow}
                        onPress={() => { close(); onOpenExpense?.(source); }}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${source.title ?? 'expense'}`}
                      >
                        {rowContent}
                      </TouchableOpacity>
                    ) : (
                      <View key={key} style={styles.detailRow}>
                        {rowContent}
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </ScrollView>
          </GlassView>
          </Animated.View>
          ) : null}
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, alignSelf: 'flex-start',  },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { maxHeight: '78%', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 20 },
  header: { flexDirection: 'row', alignItems: 'flex-start', padding: 18, gap: 12 },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingBottom: 12, gap: 10 },
  section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12, gap: 8 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 8,  paddingVertical: 3 },
});

export default AiEvidenceSheet;
