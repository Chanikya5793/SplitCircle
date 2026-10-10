// The narrative slot on the stats screens when no report is showing yet:
// either an explicit "Generate" action (reports are a metered allowance) or a
// calm note that the allowance is used up, with a way to see why.
import { GlassView } from '@/components/GlassView';
import { AppButton } from '@/components/ui/AppButton';
import { useTheme } from '@/context/ThemeContext';
import { openUsage } from '@/services/meteredAccess';
import { describeResetTime } from '@/utils/monetizationPresentation';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

interface InsightReportPromptProps {
  canGenerate: boolean;
  limitedUntil: number | null | undefined;
  onGenerate: () => Promise<void>;
  backTitle: string;
}

export const InsightReportPrompt = ({ canGenerate, limitedUntil, onGenerate, backTitle }: InsightReportPromptProps) => {
  const { theme } = useTheme();
  const limited = limitedUntil !== undefined;
  if (!canGenerate && !limited) return null;

  return (
    <GlassView style={styles.card}>
      <View style={styles.header}>
        <Icon source={limited ? 'timer-sand' : 'creation'} size={18} color={theme.colors.primary} />
        <Text variant="titleSmall" style={{ color: theme.colors.onSurface, flex: 1 }}>
          {limited ? 'AI summary limit reached' : 'AI summary'}
        </Text>
      </View>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        {limited
          ? `You've used your included AI insight reports${limitedUntil ? `. More ${describeResetTime(limitedUntil)}` : ''}. Your charts and history are always free.`
          : 'Turn these numbers into a short written summary. Each new summary uses one AI insight report; reopening it later is free.'}
      </Text>
      <AppButton
        variant={limited ? 'secondary' : 'primary'}
        compact
        icon={limited ? 'chart-box-outline' : 'creation'}
        onPress={limited ? async () => openUsage(backTitle) : onGenerate}
        style={styles.button}
      >
        {limited ? 'See usage' : 'Generate summary'}
      </AppButton>
    </GlassView>
  );
};

const styles = StyleSheet.create({
  card: { padding: 16, gap: 8, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { alignSelf: 'flex-start', marginTop: 4 },
});
