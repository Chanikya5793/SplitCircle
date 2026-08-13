import { LiquidBackground } from '@/components/LiquidBackground';
import { GlassCard, ListRow, SCREEN_GUTTER, SectionLabel } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type {
  SecurityCenterSnapshot,
  SecurityFinding,
  SecurityFindingState,
  SecurityIdentityType,
} from '@/models/security';
import {
  analyzeSecurityUrl,
  deleteAllSecurityMonitoringData,
  enrollSecurityIdentity,
  getSecurityCenter,
  removeSecurityIdentity,
  startSecurityScan,
  updateSecurityFinding,
  updateSecurityPreferences,
  verifySecurityIdentity,
} from '@/services/securityMonitoringService';
import { checkPwnedPassword, type PwnedPasswordResult } from '@/services/pwnedPasswordService';
import { appAlert } from '@/utils/appAlert';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Button, Checkbox, Icon, Switch, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SecurityFindingCard } from './SecurityFindingCard';

type FindingFilter = 'active' | 'resolved' | 'muted';

const EMPTY_SNAPSHOT: SecurityCenterSnapshot = {
  enabled: false,
  consentVersion: null,
  detailedNotifications: false,
  lastScanAt: null,
  nextScanAt: null,
  securityScore: 100,
  providerStatus: {},
  identities: [],
  findings: [],
  timeline: [],
};

const IDENTITY_LABEL: Record<SecurityIdentityType, string> = {
  email: 'Email',
  username: 'Username',
  phone: 'Phone',
  domain: 'Domain',
};

const errorText = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/^Firebase:\s*/i, '').replace(/\s*\(functions\/[a-z-]+\)\.?$/i, '');
  }
  return fallback;
};

const relativeDate = (value: number | null): string => {
  if (!value) return 'Never';
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const providerLabel = (provider: string): string => ({
  hibp: 'Have I Been Pwned',
  flare: 'Flare dark-web intelligence',
  google_web_risk: 'Google Web Risk',
}[provider] ?? provider);

const providerStatusCopy = (status: SecurityCenterSnapshot['providerStatus'][string]): string => {
  if (status.status === 'success') return `${status.findingCount} findings · ${status.latencyMs}ms`;
  if (status.status === 'partial') return status.message ?? 'Partial result — some sources were unavailable';
  if (status.status === 'not_configured') return 'Not configured on the backend';
  if (status.status === 'rate_limited') return 'Rate limited — will retry later';
  if (status.status === 'unsupported_identity') return 'No compatible monitored identity';
  return status.message ?? 'Provider unavailable';
};

interface EnrollmentModalProps {
  visible: boolean;
  initialEmail?: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (type: SecurityIdentityType, value: string) => Promise<void>;
}

const EnrollmentModal = ({ visible, initialEmail, busy, onClose, onSubmit }: EnrollmentModalProps) => {
  const { theme } = useTheme();
  const [type, setType] = useState<SecurityIdentityType>('email');
  const [value, setValue] = useState(initialEmail ?? '');
  const [consent, setConsent] = useState(false);

  const choose = (next: SecurityIdentityType) => {
    setType(next);
    setValue(next === 'email' ? initialEmail ?? '' : '');
  };

  const close = () => {
    if (busy) return;
    setConsent(false);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={close} accessibilityLabel="Close enrollment" />
        <View style={[styles.sheet, { backgroundColor: theme.colors.surface }]}>
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '800' }}>Monitor an identity</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 3 }}>
                Encrypted before storage. Provider access happens only during an approved scan.
              </Text>
            </View>
            <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close">
              <Icon source="close" size={24} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          </View>

          <View style={styles.typeRow}>
            {(Object.keys(IDENTITY_LABEL) as SecurityIdentityType[]).map((item) => (
              <TouchableOpacity
                key={item}
                onPress={() => choose(item)}
                style={[
                  styles.typeChip,
                  { borderColor: type === item ? theme.colors.primary : theme.colors.outlineVariant },
                  type === item && { backgroundColor: theme.colors.primaryContainer },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: type === item }}
              >
                <Text variant="labelMedium" style={{ color: type === item ? theme.colors.primary : theme.colors.onSurfaceVariant }}>
                  {IDENTITY_LABEL[item]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            mode="outlined"
            label={IDENTITY_LABEL[type]}
            value={value}
            onChangeText={setValue}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={type === 'email' ? 'email-address' : type === 'phone' ? 'phone-pad' : 'default'}
            placeholder={type === 'domain' ? 'example.com' : type === 'phone' ? '+1 555 123 4567' : undefined}
          />

          {type === 'username' || type === 'phone' ? (
            <View style={[styles.notice, { backgroundColor: theme.colors.warningContainer }]}>
              <Icon source="information-outline" size={18} color={theme.colors.warning} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurface, flex: 1 }}>
                Monitoring starts only after an approved ownership proof. Phone numbers matching your verified sign-in number are verified automatically.
              </Text>
            </View>
          ) : null}

          <TouchableOpacity style={styles.consentRow} onPress={() => setConsent((current) => !current)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }}>
            <Checkbox status={consent ? 'checked' : 'unchecked'} />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, lineHeight: 18 }}>
              I authorize ManaSplit to send this identity to the named monitoring providers during scans. I can revoke consent and delete monitoring data at any time.
            </Text>
          </TouchableOpacity>

          <Button
            mode="contained"
            disabled={!value.trim() || !consent || busy}
            loading={busy}
            onPress={() => void onSubmit(type, value)}
          >
            Encrypt and enroll
          </Button>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

export const SecurityCenterScreen = () => {
  const { theme, surfaceStyle } = useTheme();
  const { user } = useAuth();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<SecurityCenterSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [filter, setFilter] = useState<FindingFilter>('active');
  const [password, setPassword] = useState('');
  const [checkingPassword, setCheckingPassword] = useState(false);
  const [passwordResult, setPasswordResult] = useState<PwnedPasswordResult | null>(null);
  const [url, setUrl] = useState('');
  const [checkingUrl, setCheckingUrl] = useState(false);
  const [urlResult, setUrlResult] = useState<Awaited<ReturnType<typeof analyzeSecurityUrl>> | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ headerTransparent: true, headerTintColor: theme.colors.primary });
  }, [navigation, theme.colors.primary]);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      setSnapshot(await getSecurityCenter());
    } catch (error) {
      appAlert('Could not load Security Center', errorText(error, 'Please try again.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const visibleFindings = useMemo(() => snapshot.findings.filter((finding) => {
    if (filter === 'active') return finding.state === 'active' || finding.state === 'acknowledged' || finding.state === 'remediated';
    return finding.state === filter;
  }), [filter, snapshot.findings]);

  const runScan = async () => {
    lightHaptic();
    if (snapshot.identities.every((identity) => identity.verificationState !== 'verified')) {
      appAlert('No verified identities', 'Verify at least one monitored identity before scanning.');
      return;
    }
    setScanning(true);
    try {
      const result = await startSecurityScan();
      successHaptic();
      await load(true);
      appAlert(
        'Scan complete',
        result.newHighRiskCount
          ? `${result.newHighRiskCount} new high-risk ${result.newHighRiskCount === 1 ? 'finding needs' : 'findings need'} attention.`
          : `Checked configured providers and normalized ${result.findingCount ?? 0} findings.`,
      );
    } catch (error) {
      appAlert('Scan did not finish', errorText(error, 'Please try again later.'));
    } finally {
      setScanning(false);
    }
  };

  const enroll = async (type: SecurityIdentityType, value: string) => {
    setEnrolling(true);
    try {
      const result = await enrollSecurityIdentity(type, value);
      setEnrollmentOpen(false);
      await load(true);
      if (result.dnsRecordName && result.dnsRecordValue) {
        appAlert('Add this DNS TXT record', `${result.dnsRecordName}\n\n${result.dnsRecordValue}\n\nReturn here and tap Verify after DNS updates.`);
      } else if (result.verificationState === 'verified') {
        appAlert('Identity protected', `${result.displayHint} is verified and ready to scan.`);
      } else {
        appAlert('Identity enrolled', 'It is encrypted, but monitoring stays off until ownership is verified.');
      }
    } catch (error) {
      appAlert('Could not enroll identity', errorText(error, 'Please check the value and try again.'));
    } finally {
      setEnrolling(false);
    }
  };

  const verify = async (identityId: string) => {
    try {
      await verifySecurityIdentity(identityId);
      successHaptic();
      await load(true);
    } catch (error) {
      appAlert('Not verified yet', errorText(error, 'The ownership proof could not be verified.'));
    }
  };

  const confirmRemoveIdentity = (identityId: string, hint: string) => {
    appAlert('Stop monitoring this identity?', `${hint} and its findings will be deleted. The provider is also asked to remove its identifier.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void removeSecurityIdentity(identityId).then(() => load(true)).catch((error) => {
          appAlert('Could not remove identity', errorText(error, 'Please try again.'));
        }),
      },
    ]);
  };

  const changeFindingState = async (findingId: string, state: SecurityFindingState) => {
    await updateSecurityFinding(findingId, state);
    setSnapshot((current) => ({
      ...current,
      findings: current.findings.map((finding) => finding.findingId === findingId ? { ...finding, state } : finding),
    }));
  };

  const toggleMonitoring = async (enabled: boolean) => {
    setSnapshot((current) => ({ ...current, enabled }));
    try {
      await updateSecurityPreferences({ enabled });
    } catch (error) {
      setSnapshot((current) => ({ ...current, enabled: !enabled }));
      appAlert('Could not update monitoring', errorText(error, 'Please try again.'));
    }
  };

  const toggleDetailedNotifications = async (enabled: boolean) => {
    setSnapshot((current) => ({ ...current, detailedNotifications: enabled }));
    try {
      await updateSecurityPreferences({ detailedNotifications: enabled });
    } catch (error) {
      setSnapshot((current) => ({ ...current, detailedNotifications: !enabled }));
      appAlert('Could not update alerts', errorText(error, 'Please try again.'));
    }
  };

  const checkPassword = async () => {
    if (!password) return;
    setCheckingPassword(true);
    setPasswordResult(null);
    try {
      const result = await checkPwnedPassword(password);
      setPassword('');
      setPasswordResult(result);
    } catch (error) {
      setPassword('');
      appAlert('Password check unavailable', errorText(error, 'Please try again.'));
    } finally {
      setCheckingPassword(false);
    }
  };

  const checkUrl = async () => {
    if (!url.trim()) return;
    setCheckingUrl(true);
    setUrlResult(null);
    try {
      setUrlResult(await analyzeSecurityUrl(url.trim()));
      setUrl('');
      await load(true);
    } catch (error) {
      appAlert('Could not analyze link', errorText(error, 'Please check the link and try again.'));
    } finally {
      setCheckingUrl(false);
    }
  };

  const deleteEverything = () => {
    appAlert('Delete all Security Center data?', 'This removes encrypted identities, findings, timeline, consent, and provider identifiers. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete everything',
        style: 'destructive',
        onPress: () => void deleteAllSecurityMonitoringData().then(() => {
          setSnapshot(EMPTY_SNAPSHOT);
          appAlert('Security data deleted', 'Monitoring is off and all Security Center data has been removed.');
        }).catch((error) => appAlert('Deletion did not finish', errorText(error, 'Please try again.'))),
      },
    ]);
  };

  const scoreColor = snapshot.securityScore >= 80 ? theme.colors.success : snapshot.securityScore >= 55 ? theme.colors.warning : theme.colors.danger;
  const cardFlat = surfaceStyle === 'flat' ? styles.cardFlat : undefined;

  return (
    <LiquidBackground style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 58, paddingBottom: insets.bottom + 40 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heroCopy}>
          <Text variant="headlineMedium" style={{ color: theme.colors.onSurface, fontWeight: '800' }}>Security Center</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 20 }}>
            Evidence first. Secrets never. Severity comes from deterministic rules—not a model.
          </Text>
        </View>

        {loading ? (
          <View style={styles.loading}><ActivityIndicator color={theme.colors.primary} /><Text style={{ color: theme.colors.onSurfaceVariant }}>Opening protected monitoring…</Text></View>
        ) : (
          <>
            <GlassCard style={[styles.heroCard, cardFlat]} contentStyle={styles.heroCardContent}>
              <View style={[styles.scoreRing, { borderColor: scoreColor }]} accessibilityLabel={`Security score ${snapshot.securityScore} out of 100`}>
                <Text variant="headlineLarge" style={{ color: scoreColor, fontWeight: '900' }}>{snapshot.securityScore}</Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>out of 100</Text>
              </View>
              <View style={styles.heroStatus}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '800' }}>
                  {snapshot.enabled ? 'Monitoring is active' : 'Monitoring is paused'}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Last scan {relativeDate(snapshot.lastScanAt)} · {snapshot.identities.filter((entry) => entry.verificationState === 'verified').length} verified
                </Text>
                <Button mode="contained" icon="radar" loading={scanning} disabled={scanning || !snapshot.enabled} onPress={() => void runScan()}>
                  Scan now
                </Button>
              </View>
            </GlassCard>

            <SectionLabel style={styles.sectionLabel}>Protection tools</SectionLabel>
            <GlassCard style={[styles.sectionCard, cardFlat]} contentStyle={styles.toolContent}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Check a password privately</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
                SHA-1 matching happens here. Only a 5-character prefix goes to HIBP; the password and full hash never leave or persist.
              </Text>
              <View style={styles.inputActionRow}>
                <TextInput
                  mode="outlined"
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.flexInput}
                  onSubmitEditing={() => void checkPassword()}
                />
                <Button mode="contained-tonal" disabled={!password || checkingPassword} loading={checkingPassword} onPress={() => void checkPassword()}>Check</Button>
              </View>
              {passwordResult ? (
                <View style={[styles.resultBox, { backgroundColor: passwordResult.exposed ? theme.colors.dangerContainer : theme.colors.successContainer }]}>
                  <Icon source={passwordResult.exposed ? 'alert-circle' : 'check-circle'} size={20} color={passwordResult.exposed ? theme.colors.danger : theme.colors.success} />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurface, flex: 1 }}>
                    {passwordResult.exposed
                      ? `Found in the Pwned Passwords corpus ${passwordResult.occurrenceCount.toLocaleString()} times. Change it anywhere it is used.`
                      : 'No match in the current Pwned Passwords corpus. This does not prove the password is otherwise safe.'}
                  </Text>
                </View>
              ) : null}

              <View style={[styles.toolDivider, { backgroundColor: theme.colors.outlineVariant }]} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Analyze a suspicious link</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
                Checks lookalikes, homoglyphs, redirect tricks, credential-themed paths, and Google Web Risk without opening the page.
              </Text>
              <View style={styles.inputActionRow}>
                <TextInput
                  mode="outlined"
                  label="Link or domain"
                  value={url}
                  onChangeText={setUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.flexInput}
                  onSubmitEditing={() => void checkUrl()}
                />
                <Button mode="contained-tonal" disabled={!url.trim() || checkingUrl} loading={checkingUrl} onPress={() => void checkUrl()}>Analyze</Button>
              </View>
              {urlResult ? (
                <View style={[styles.resultBox, { backgroundColor: urlResult.safeToOpen ? theme.colors.successContainer : theme.colors.warningContainer }]}>
                  <Icon source={urlResult.safeToOpen ? 'shield-check' : 'shield-alert'} size={20} color={urlResult.safeToOpen ? theme.colors.success : theme.colors.warning} />
                  <View style={{ flex: 1 }}>
                    <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                      {urlResult.hostname} · {urlResult.risk.severity} risk
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {urlResult.indicators.length > 0
                        ? urlResult.indicators.map((indicator) => indicator.label).join(' · ')
                        : urlResult.providerStatus === 'success'
                          ? 'No configured signal matched; stay cautious.'
                          : 'Reputation provider unavailable; no safety verdict was issued.'}
                    </Text>
                  </View>
                </View>
              ) : null}
            </GlassCard>

            <View style={styles.sectionHeaderRow}>
              <SectionLabel style={styles.sectionLabel}>Monitored identities</SectionLabel>
              <Button compact icon="plus" onPress={() => setEnrollmentOpen(true)}>Add</Button>
            </View>
            <GlassCard style={[styles.sectionCard, cardFlat]} contentStyle={styles.listContent}>
              {snapshot.identities.length === 0 ? (
                <TouchableOpacity style={styles.emptyState} onPress={() => setEnrollmentOpen(true)} accessibilityRole="button">
                  <Icon source="account-lock-outline" size={30} color={theme.colors.primary} />
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>No identity leaves this screen until you consent</Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>Add your verified sign-in email or prove control of a domain to begin.</Text>
                </TouchableOpacity>
              ) : snapshot.identities.map((identity, index) => (
                <View key={identity.identityId}>
                  {index > 0 ? <View style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} /> : null}
                  <ListRow
                    title={identity.displayHint}
                    subtitle={`${IDENTITY_LABEL[identity.type]} · ${identity.verificationState === 'verified' ? 'Verified and scanning' : identity.verificationMethod === 'dns_txt' ? 'DNS proof pending' : 'Ownership proof pending'}`}
                    icon={identity.verificationState === 'verified' ? 'shield-check-outline' : 'shield-key-outline'}
                    iconColor={identity.verificationState === 'verified' ? theme.colors.success : theme.colors.warning}
                    chevron={false}
                    trailing={(
                      <View style={styles.identityActions}>
                        {identity.verificationState !== 'verified' ? <Button compact onPress={() => void verify(identity.identityId)}>Verify</Button> : null}
                        <TouchableOpacity onPress={() => confirmRemoveIdentity(identity.identityId, identity.displayHint)} accessibilityRole="button" accessibilityLabel={`Remove ${identity.displayHint}`}>
                          <Icon source="trash-can-outline" size={20} color={theme.colors.danger} />
                        </TouchableOpacity>
                      </View>
                    )}
                  />
                </View>
              ))}
            </GlassCard>

            <SectionLabel style={styles.sectionLabel}>Provider health</SectionLabel>
            <GlassCard style={[styles.sectionCard, cardFlat]} contentStyle={styles.listContent}>
              {Object.keys(snapshot.providerStatus).length === 0 ? (
                <View style={styles.emptyProvider}>
                  <Icon source="cloud-search-outline" size={22} color={theme.colors.onSurfaceVariant} />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>Run a scan to measure provider status and latency.</Text>
                </View>
              ) : Object.entries(snapshot.providerStatus).map(([provider, status], index) => (
                <View key={provider}>
                  {index > 0 ? <View style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} /> : null}
                  <ListRow
                    title={providerLabel(provider)}
                    subtitle={providerStatusCopy(status)}
                    icon={status.status === 'success' ? 'check-decagram-outline' : status.status === 'not_configured' ? 'cog-outline' : 'alert-circle-outline'}
                    iconColor={status.status === 'success' ? theme.colors.success : status.status === 'not_configured' ? theme.colors.onSurfaceVariant : theme.colors.warning}
                    chevron={false}
                  />
                </View>
              ))}
            </GlassCard>

            <View style={styles.sectionHeaderRow}>
              <SectionLabel style={styles.sectionLabel}>Findings</SectionLabel>
              <View style={styles.filterRow} accessibilityRole="tablist">
                {(['active', 'resolved', 'muted'] as FindingFilter[]).map((item) => (
                  <TouchableOpacity
                    key={item}
                    onPress={() => setFilter(item)}
                    style={[styles.filterChip, filter === item && { backgroundColor: theme.colors.primaryContainer }]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: filter === item }}
                  >
                    <Text variant="labelSmall" style={{ color: filter === item ? theme.colors.primary : theme.colors.onSurfaceVariant, textTransform: 'capitalize' }}>{item}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={styles.findingList}>
              {visibleFindings.length === 0 ? (
                <GlassCard style={[styles.sectionCard, cardFlat]} contentStyle={styles.emptyState}>
                  <Icon source="shield-check-outline" size={32} color={theme.colors.success} />
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>No {filter} findings</Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>A clean list means no current match—not a promise that an account can never be compromised.</Text>
                </GlassCard>
              ) : visibleFindings.map((finding: SecurityFinding) => (
                <SecurityFindingCard
                  key={finding.findingId}
                  finding={finding}
                  onStateChange={(state) => changeFindingState(finding.findingId, state)}
                />
              ))}
            </View>

            <SectionLabel style={styles.sectionLabel}>Privacy controls</SectionLabel>
            <GlassCard style={[styles.sectionCard, cardFlat]} contentStyle={styles.listContent}>
              <ListRow
                title="Scheduled monitoring"
                subtitle={snapshot.enabled ? 'Daily scans and high-risk alerts are enabled' : 'No scheduled provider requests are made'}
                icon="radar"
                trailing={<Switch value={snapshot.enabled} onValueChange={(value) => void toggleMonitoring(value)} />}
              />
              <View style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} />
              <ListRow
                title="Detailed alert previews"
                subtitle={snapshot.detailedNotifications ? 'Lock screen may show severity, never identity or breach details' : 'Generic protected copy on the lock screen'}
                icon="bell-lock-outline"
                trailing={<Switch value={snapshot.detailedNotifications} onValueChange={(value) => void toggleDetailedNotifications(value)} />}
              />
              <View style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} />
              <ListRow
                title="Delete Security Center data"
                subtitle="Erase consent, encrypted identities, findings, timeline, and provider identifiers"
                icon="delete-forever-outline"
                destructive
                chevron={false}
                onPress={deleteEverything}
              />
            </GlassCard>

            {snapshot.timeline.length > 0 ? (
              <>
                <SectionLabel style={styles.sectionLabel}>Recent timeline</SectionLabel>
                <GlassCard style={[styles.sectionCard, cardFlat]} contentStyle={styles.timelineContent}>
                  {snapshot.timeline.slice(0, 8).map((event, index) => (
                    <View key={event.eventId} style={styles.timelineRow}>
                      <View style={styles.timelineRail}>
                        <View style={[styles.timelineDot, { backgroundColor: theme.colors.primary }]} />
                        {index < Math.min(7, snapshot.timeline.length - 1) ? <View style={[styles.timelineLine, { backgroundColor: theme.colors.outlineVariant }]} /> : null}
                      </View>
                      <View style={{ flex: 1, paddingBottom: 13 }}>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurface, textTransform: 'capitalize' }}>{event.type.replace(/_/g, ' ')}</Text>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{relativeDate(event.createdAt)}</Text>
                      </View>
                    </View>
                  ))}
                </GlassCard>
              </>
            ) : null}
          </>
        )}
      </ScrollView>

      <EnrollmentModal
        visible={enrollmentOpen}
        initialEmail={user?.email ?? undefined}
        busy={enrolling}
        onClose={() => setEnrollmentOpen(false)}
        onSubmit={enroll}
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { gap: 10 },
  heroCopy: { paddingHorizontal: SCREEN_GUTTER, gap: 5, marginBottom: 3 },
  loading: { paddingVertical: 80, alignItems: 'center', justifyContent: 'center', gap: 12 },
  heroCard: { marginHorizontal: SCREEN_GUTTER },
  heroCardContent: { padding: 18, flexDirection: 'row', alignItems: 'center', gap: 17 },
  scoreRing: { width: 96, height: 96, borderRadius: 48, borderWidth: 7, alignItems: 'center', justifyContent: 'center' },
  heroStatus: { flex: 1, alignItems: 'flex-start', gap: 7 },
  sectionLabel: { marginHorizontal: SCREEN_GUTTER, marginTop: 13 },
  sectionCard: { marginHorizontal: SCREEN_GUTTER },
  cardFlat: { marginHorizontal: 0, borderRadius: 0 },
  toolContent: { padding: 16, gap: 9 },
  inputActionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexInput: { flex: 1 },
  resultBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 13, padding: 11 },
  toolDivider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingRight: SCREEN_GUTTER },
  listContent: { paddingVertical: 3 },
  rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 58 },
  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  emptyProvider: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 18 },
  identityActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  filterChip: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  findingList: { gap: 10 },
  timelineContent: { padding: 15 },
  timelineRow: { flexDirection: 'row', gap: 10 },
  timelineRail: { width: 12, alignItems: 'center' },
  timelineDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  timelineLine: { width: 1, flex: 1, marginTop: 3 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 34, gap: 15 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  typeChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 12, padding: 10 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 3 },
});
