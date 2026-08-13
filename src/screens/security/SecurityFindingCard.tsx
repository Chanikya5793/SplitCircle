import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { SecurityFinding, SecurityFindingState, SecurityFindingSeverity } from '@/models/security';
import { explainSecurityFinding, type SecurityExplanation } from '@/services/securityAnalystService';
import { lightHaptic } from '@/utils/haptics';
import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';

interface SecurityFindingCardProps {
  finding: SecurityFinding;
  onStateChange: (state: SecurityFindingState) => Promise<void>;
  onDelete: () => void;
}

const SOURCE_LABEL: Record<SecurityFinding['source'], string> = {
  hibp: 'Have I Been Pwned',
  flare: 'Flare',
  google_web_risk: 'Google Web Risk',
  manasplit: 'ManaSplit analysis',
};

const SEVERITY_ICON: Record<SecurityFindingSeverity, string> = {
  critical: 'alert-octagon',
  high: 'alert-circle',
  medium: 'shield-alert-outline',
  low: 'shield-outline',
  info: 'information-outline',
};

const OFFICIAL_SECURITY_PAGES: Record<string, string> = {
  'apple.com': 'https://account.apple.com/',
  'google.com': 'https://myaccount.google.com/security',
  'microsoft.com': 'https://account.microsoft.com/security',
  'paypal.com': 'https://www.paypal.com/myaccount/security/',
  'amazon.com': 'https://www.amazon.com/hz/mycd/myx?pageType=content&ref_=ya_d_l_manage_devices',
  'facebook.com': 'https://www.facebook.com/security/2fac/setup/intro/',
  'instagram.com': 'https://www.instagram.com/accounts/password/change/',
  'netflix.com': 'https://www.netflix.com/manageaccountaccess',
  'coinbase.com': 'https://accounts.coinbase.com/security',
};

const officialPageFor = (finding: SecurityFinding): string | null => {
  const domain = finding.evidence.find((entry) => entry.key === 'domain' || entry.key === 'affectedService')?.value.toLowerCase();
  if (!domain) return null;
  const match = Object.entries(OFFICIAL_SECURITY_PAGES).find(([official]) => domain === official || domain.endsWith(`.${official}`));
  return match?.[1] ?? null;
};

export const SecurityFindingCard = ({ finding, onStateChange, onDelete }: SecurityFindingCardProps) => {
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState<SecurityExplanation | null>(null);
  const severity = finding.assessment.severity;
  const severityColor = severity === 'critical' || severity === 'high'
    ? theme.colors.danger
    : severity === 'medium'
      ? theme.colors.warning
      : theme.colors.primary;
  const officialPage = officialPageFor(finding);

  const changeState = async (state: SecurityFindingState) => {
    setBusy(true);
    try {
      await onStateChange(state);
    } finally {
      setBusy(false);
    }
  };

  const explain = async () => {
    lightHaptic();
    setExplaining(true);
    try {
      setExplanation(await explainSecurityFinding(finding));
      setExpanded(true);
    } finally {
      setExplaining(false);
    }
  };

  return (
    <GlassCard style={styles.card} contentStyle={styles.content}>
      <TouchableOpacity
        activeOpacity={0.82}
        accessibilityRole="button"
        accessibilityLabel={`${severity} severity: ${finding.title}`}
        onPress={() => setExpanded((value) => !value)}
      >
        <View style={styles.header}>
          <View style={[styles.icon, { backgroundColor: `${severityColor}18` }]}>
            <Icon source={SEVERITY_ICON[severity]} size={22} color={severityColor} />
          </View>
          <View style={styles.headerCopy}>
            <View style={styles.metaRow}>
              <Text variant="labelSmall" style={{ color: severityColor, fontWeight: '800', textTransform: 'uppercase' }}>
                {severity} · {finding.assessment.score}/100 risk
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {Math.round(finding.assessment.confidence * 100)}% confidence
              </Text>
            </View>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {finding.title}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 3, lineHeight: 18 }}>
              {finding.summary}
            </Text>
          </View>
          <Icon source={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.onSurfaceVariant} />
        </View>
      </TouchableOpacity>

      <View style={styles.sourceRow}>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {SOURCE_LABEL[finding.source]} · {finding.identityHint}
        </Text>
        {finding.occurrenceCount > 1 ? (
          <Text variant="labelSmall" style={{ color: theme.colors.warning }}>
            Seen {finding.occurrenceCount} times
          </Text>
        ) : null}
      </View>

      {expanded ? (
        <View style={[styles.details, { borderTopColor: theme.colors.outlineVariant }]}>
          {finding.assessment.factors.length > 0 ? (
            <View style={styles.block}>
              <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Why it scored this way</Text>
              {finding.assessment.factors.map((factor) => (
                <View key={factor.code} style={styles.detailRow}>
                  <Icon source={factor.points < 0 ? 'shield-check-outline' : 'circle-small'} size={17} color={factor.points < 0 ? theme.colors.success : severityColor} />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>{factor.label}</Text>
                  <Text variant="labelSmall" style={{ color: factor.points < 0 ? theme.colors.success : severityColor }}>
                    {factor.points > 0 ? '+' : ''}{factor.points}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {finding.evidence.length > 0 ? (
            <View style={styles.block}>
              <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Safe evidence</Text>
              {finding.evidence.map((entry, index) => (
                <View key={`${entry.key}:${index}`} style={styles.detailRow}>
                  <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>[E{index + 1}]</Text>
                  <View style={{ flex: 1 }}>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{entry.label}</Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurface }}>{entry.value}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.block}>
            <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Do this next</Text>
            {finding.assessment.recommendedActions.map((action, index) => (
              <View key={`${action}:${index}`} style={styles.detailRow}>
                <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>{index + 1}</Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, lineHeight: 18 }}>{action}</Text>
              </View>
            ))}
            {officialPage ? (
              <Button
                mode="outlined"
                icon="open-in-new"
                onPress={() => void Linking.openURL(officialPage)}
                accessibilityHint="Opens the allowlisted official account security page"
              >
                Open official security page
              </Button>
            ) : null}
          </View>

          {explanation ? (
            <View style={[styles.aiBlock, { backgroundColor: theme.colors.primaryContainer }]}>
              <View style={styles.aiLabel}>
                <Icon source={explanation.source === 'ondevice' ? 'chip' : explanation.source === 'pcc' ? 'cloud-lock-outline' : 'calculator-variant-outline'} size={16} color={theme.colors.primary} />
                <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                  {explanation.source === 'ondevice' ? 'On-device explanation' : explanation.source === 'pcc' ? 'Private Cloud explanation' : 'Deterministic explanation'}
                </Text>
              </View>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurface, lineHeight: 19 }}>{explanation.text}</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button compact mode="text" disabled={explaining} onPress={() => void explain()}>
              {explaining ? 'Explaining…' : 'Explain with AI'}
            </Button>
            {finding.state === 'active' ? (
              <Button compact mode="text" disabled={busy} onPress={() => void changeState('acknowledged')}>Acknowledge</Button>
            ) : null}
            {finding.state !== 'resolved' ? (
              <Button compact mode="contained-tonal" disabled={busy} onPress={() => void changeState('remediated')}>Mark remediated</Button>
            ) : null}
            {finding.state !== 'muted' ? (
              <Button compact mode="text" textColor={theme.colors.onSurfaceVariant} disabled={busy} onPress={() => void changeState('muted')}>Mute</Button>
            ) : null}
            <Button compact mode="text" textColor={theme.colors.danger} disabled={busy} onPress={onDelete}>Delete</Button>
            {busy ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
          </View>
        </View>
      ) : null}
    </GlassCard>
  );
};

const styles = StyleSheet.create({
  card: { marginHorizontal: 16 },
  content: { padding: 14 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  icon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10, paddingLeft: 53 },
  details: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 13, paddingTop: 13, gap: 15 },
  block: { gap: 8 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  aiBlock: { borderRadius: 14, padding: 12, gap: 7 },
  aiLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
});
