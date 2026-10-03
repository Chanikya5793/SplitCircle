import { DetailScreenScaffold } from '@/components/ui/DetailScreenScaffold';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ScrimBackdrop } from '@/components/ui/ScrimBackdrop';
import { AppButton, fullBleed, GlassCard, ListRow, SCREEN_GUTTER, SectionLabel, SelectableChip } from '@/components/ui';
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
  deleteSecurityFinding,
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

  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Button, Checkbox, Icon, Switch, Text, TextInput } from 'react-native-paper';
import Animated, { SlideInDown } from 'react-native-reanimated';
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
  console.warn('[SecurityCenter] Operation failed:', error);
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
  if (status.status === 'success') return `${status.findingCount} ${status.findingCount === 1 ? 'finding' : 'findings'}`;
  if (status.status === 'partial') return 'Some checks were unavailable';
  if (status.status === 'not_configured') return 'This source is not available';
  if (status.status === 'rate_limited') return 'Temporarily unavailable. ManaSplit will try later.';
  if (status.status === 'unsupported_identity') return 'This source cannot check the selected identity';
  return 'This source is unavailable';
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
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Close enrollment">
          <ScrimBackdrop />
        </TouchableOpacity>
        {visible ? (
        <Animated.View entering={SlideInDown.springify().damping(30).stiffness(350)} accessibilityViewIsModal>
        <GlassCard role="floating" radius={28} style={styles.sheet} contentStyle={styles.sheetContent}>
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '800' }}>Add monitoring</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 3 }}>
                Your information is encrypted and checked only when you run a scan.
              </Text>
            </View>
            <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close enrollment" style={styles.sheetClose}>
              <Icon source="close" size={24} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          </View>

          <View style={styles.typeRow}>
            {(Object.keys(IDENTITY_LABEL) as SecurityIdentityType[]).map((item) => (
              <SelectableChip
                key={item}
                label={IDENTITY_LABEL[item]}
                selected={type === item}
                accessibilityRole="radio"
                onPress={() => choose(item)}
              />
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
                Monitoring starts after you verify that this belongs to you. A phone number that matches your verified sign-in number is confirmed automatically.
              </Text>
            </View>
          ) : null}

          <TouchableOpacity style={styles.consentRow} onPress={() => setConsent((current) => !current)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }}>
            <Checkbox status={consent ? 'checked' : 'unchecked'} />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, lineHeight: 18 }}>
              I agree to let ManaSplit check this identity with the services named in Coverage details. I can stop monitoring and delete this data at any time.
            </Text>
          </TouchableOpacity>

          <AppButton
            disabled={!value.trim() || !consent || busy}
            loading={busy}
            onPress={() => void onSubmit(type, value)}
          >
            Add to monitoring
          </AppButton>
        </GlassCard>
        </Animated.View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
};

export const SecurityCenterScreen = () => {
  const { theme, surfaceStyle } = useTheme();
  const { user } = useAuth();
  const navigation = useNavigation();
  const [snapshot, setSnapshot] = useState<SecurityCenterSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [providerDetailsExpanded, setProviderDetailsExpanded] = useState(false);
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
          : `Checked the available sources. Found ${result.findingCount ?? 0} saved ${(result.findingCount ?? 0) === 1 ? 'finding' : 'findings'}.`,
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
    appAlert('Stop monitoring this identity?', `${hint} and its findings will be deleted. Monitoring services will also be asked to remove the saved monitoring data.`, [
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

  const confirmDeleteFinding = (findingId: string) => {
    appAlert('Delete this finding?', 'The saved evidence and its risk assessment will be permanently removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void deleteSecurityFinding(findingId).then(() => {
          setSnapshot((current) => ({
            ...current,
            findings: current.findings.filter((finding) => finding.findingId !== findingId),
          }));
        }).catch((error) => appAlert('Could not delete finding', errorText(error, 'Please try again.'))),
      },
    ]);
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
    appAlert('Delete all Security Center data?', 'This removes monitored identities, findings, history, preferences, and saved monitoring data. This cannot be undone.', [
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

  const verifiedCount = snapshot.identities.filter((identity) => identity.verificationState === 'verified').length;
  const pendingCount = snapshot.identities.length - verifiedCount;
  const activeCount = snapshot.findings.filter((finding) => ['active', 'acknowledged', 'remediated'].includes(finding.state)).length;
  const providers = Object.values(snapshot.providerStatus);
  const successfulProviders = providers.filter((provider) => provider.status === 'success').length;
  const coverageIncomplete = providers.length === 0 || successfulProviders < providers.length;
  const coverageTitle = snapshot.identities.length === 0 ? 'Add an identity to begin'
    : verifiedCount === 0 ? 'Verify ownership to begin'
      : !snapshot.enabled ? 'Monitoring is paused'
        : !snapshot.lastScanAt ? 'Ready for your first check'
          : successfulProviders === 0 && !providers.some((provider) => provider.status === 'partial') ? 'Coverage is unavailable'
            : coverageIncomplete ? 'Some checks are unavailable'
              : 'Monitoring is enabled';
  const coverageCopy = snapshot.identities.length === 0 ? 'Add an email address or domain, then verify ownership before monitoring starts.'
    : verifiedCount === 0 ? 'Ownership verification is still needed. No identity is ready to scan.'
      : !snapshot.enabled ? 'Scheduled checks are off. Turn on Scheduled monitoring below to resume.'
        : !snapshot.lastScanAt ? 'Run a scan to check the available sources. Nothing has been checked yet.'
          : coverageIncomplete ? 'The last scan did not establish full coverage. Open Coverage details to see which sources could be checked.'
            : 'Available sources were checked. No service can guarantee that an account is safe.';

  // Flat sections that contain ordinary copy stay inside the same readable
  // gutter as their labels. Only row lists may reach the screen edge because
  // ListRow owns its own horizontal inset and its press state benefits from
  // spanning the full width.
  const rowCardFlat = surfaceStyle === 'flat' ? styles.rowCardFlat : undefined;

  return (
    <LiquidBackground style={styles.root}>
      <DetailScreenScaffold bottomSpacing={40}
        horizontalInset={SCREEN_GUTTER}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heroCopy}>
          <Text variant="headlineMedium" style={{ color: theme.colors.onSurface, fontWeight: '800' }}>Security Center</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 20 }}>
            See what has been checked and what needs your attention.
          </Text>
        </View>

        {loading ? (
          <View style={styles.loading}><ActivityIndicator color={theme.colors.primary} /><Text style={{ color: theme.colors.onSurfaceVariant }}>Opening protected monitoring…</Text></View>
        ) : (
          <>
            <GlassCard contentStyle={styles.heroCardContent}>
              <View style={styles.heroStatus}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '800' }}>
                  {coverageTitle}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {verifiedCount} verified · {pendingCount} not verified{'\n'}
                  Last check: {snapshot.lastScanAt ? relativeDate(snapshot.lastScanAt) : 'Not checked yet'}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{coverageCopy}</Text>
                <Text variant="bodyMedium" style={{ color: activeCount ? theme.colors.warning : theme.colors.onSurface }}>
                  {activeCount ? `${activeCount} ${activeCount === 1 ? 'finding needs' : 'findings need'} review` : snapshot.lastScanAt ? 'No active findings in the saved results' : 'No findings yet; a scan is needed'}
                </Text>
                <Button mode="contained" icon="radar" loading={scanning} disabled={scanning || !snapshot.enabled || verifiedCount === 0} onPress={() => void runScan()}>
                  Scan now
                </Button>
              </View>
            </GlassCard>

            <View style={styles.sectionHeaderRow}>
              <SectionLabel style={styles.sectionLabel}>Findings</SectionLabel>
              <View style={styles.filterRow} accessibilityRole="tablist">
                {(['active', 'resolved', 'muted'] as FindingFilter[]).map((item) => (
                  <SelectableChip
                    key={item}
                    label={item.charAt(0).toUpperCase() + item.slice(1)}
                    selected={filter === item}
                    onPress={() => setFilter(item)}
                    accessibilityRole="tab"
                  />
                ))}
              </View>
            </View>
            <View style={styles.findingList}>
              {visibleFindings.length === 0 ? (
                <GlassCard contentStyle={styles.emptyState}>
                  <Icon source="clipboard-text-outline" size={32} color={theme.colors.onSurfaceVariant} />
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>No {filter} findings</Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>This list only reflects saved results. Missing checks or an empty list do not establish that an account is safe.</Text>
                </GlassCard>
              ) : visibleFindings.map((finding: SecurityFinding) => (
                <SecurityFindingCard
                  key={finding.findingId}
                  finding={finding}
                  onStateChange={(state) => changeFindingState(finding.findingId, state)}
                  onDelete={() => confirmDeleteFinding(finding.findingId)}
                />
              ))}
            </View>

            <SectionLabel style={styles.sectionLabel}>Protection tools</SectionLabel>
            <GlassCard contentStyle={styles.toolContent}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Check a password privately</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
                Check whether this password appears in known breaches. Your password is not sent or saved. Matching happens on this device; only the first five characters of its SHA-1 hash go to Have I Been Pwned.
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
                      ? `Found in the Pwned Passwords breach database ${passwordResult.occurrenceCount.toLocaleString()} times. Change it anywhere it is used.`
                      : 'No match in the current Pwned Passwords breach database. This does not prove the password is otherwise safe.'}
                  </Text>
                </View>
              ) : null}

              <View style={[styles.toolDivider, { backgroundColor: theme.colors.outlineVariant }]} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>Analyze a suspicious link</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 18 }}>
                Check for deceptive addresses and known threats without opening the page. The link is analyzed for lookalike characters and suspicious patterns, with a reputation check through Google Web Risk when available.
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
                          : 'The link check is unavailable, so ManaSplit cannot assess this address right now.'}
                    </Text>
                  </View>
                </View>
              ) : null}
            </GlassCard>

            <View style={styles.sectionHeaderRow}>
              <SectionLabel style={styles.sectionLabel}>Monitored identities</SectionLabel>
              <Button compact icon="plus" onPress={() => setEnrollmentOpen(true)}>Add</Button>
            </View>
            <GlassCard style={rowCardFlat} contentStyle={styles.listContent}>
              {snapshot.identities.length === 0 ? (
                <TouchableOpacity style={styles.emptyState} onPress={() => setEnrollmentOpen(true)} accessibilityRole="button">
                  <Icon source="account-lock-outline" size={30} color={theme.colors.primary} />
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>No monitored identities yet</Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>Add your verified sign-in email or prove control of a domain to begin.</Text>
                </TouchableOpacity>
              ) : snapshot.identities.map((identity, index) => (
                <View key={identity.identityId}>
                  {index > 0 ? <View style={[styles.rowDivider, { backgroundColor: theme.colors.outlineVariant }]} /> : null}
                  <ListRow
                    title={identity.displayHint}
                    subtitle={`${IDENTITY_LABEL[identity.type]} · ${identity.verificationState === 'verified' ? snapshot.enabled ? 'Verified; monitoring enabled' : 'Verified; monitoring paused' : identity.verificationState === 'failed' ? 'Verification failed' : identity.verificationMethod === 'dns_txt' ? 'DNS proof pending' : 'Ownership proof pending'}`}
                    icon={identity.verificationState === 'verified' ? 'shield-check-outline' : 'shield-key-outline'}
                    iconColor={identity.verificationState === 'verified' ? theme.colors.success : theme.colors.warning}
                    chevron={false}
                    trailing={(
                      <View style={styles.identityActions}>
                        {identity.verificationState !== 'verified' ? <Button compact onPress={() => void verify(identity.identityId)}>Verify</Button> : null}
                        <TouchableOpacity onPress={() => confirmRemoveIdentity(identity.identityId, identity.displayHint)} accessibilityRole="button" accessibilityLabel={`Remove ${identity.displayHint}`} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                          <Icon source="trash-can-outline" size={20} color={theme.colors.danger} />
                        </TouchableOpacity>
                      </View>
                    )}
                  />
                </View>
              ))}
            </GlassCard>

            <Button
              icon={providerDetailsExpanded ? 'chevron-up' : 'chevron-down'}
              accessibilityState={{ expanded: providerDetailsExpanded }}
              onPress={() => setProviderDetailsExpanded((expanded) => !expanded)}
            >Coverage details</Button>
            {providerDetailsExpanded ? (
              <View>
            <GlassCard style={rowCardFlat} contentStyle={styles.listContent}>
              {Object.keys(snapshot.providerStatus).length === 0 ? (
                <View style={styles.emptyProvider}>
                  <Icon source="cloud-search-outline" size={22} color={theme.colors.onSurfaceVariant} />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>Run a scan to see which sources are available.</Text>
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

              </View>
            ) : null}

            <SectionLabel style={styles.sectionLabel}>Privacy controls</SectionLabel>
            <GlassCard style={rowCardFlat} contentStyle={styles.listContent}>
              <ListRow
                title="Scheduled monitoring"
                subtitle={snapshot.enabled ? 'Daily scans and high-risk alerts are enabled' : 'No scheduled checks are made'}
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
                subtitle="Erase monitored identities, findings, history, preferences, and saved monitoring data"
                icon="delete-forever-outline"
                destructive
                chevron={false}
                onPress={deleteEverything}
              />
            </GlassCard>

            {snapshot.timeline.length > 0 ? (
              <>
                <SectionLabel style={styles.sectionLabel}>Recent timeline</SectionLabel>
                <GlassCard contentStyle={styles.timelineContent}>
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
      </DetailScreenScaffold>

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
  heroCopy: { gap: 5, marginBottom: 3 },
  loading: { paddingVertical: 80, alignItems: 'center', justifyContent: 'center', gap: 12 },
  heroCardContent: { padding: 18, gap: 16 },
  heroStatus: { alignItems: 'stretch', gap: 7 },
  sectionLabel: { marginTop: 13 },
  rowCardFlat: { borderRadius: 0, ...fullBleed },
  toolContent: { padding: 16, gap: 9 },
  inputActionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexInput: { flex: 1 },
  resultBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 13, padding: 11 },
  toolDivider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  listContent: { paddingVertical: 3 },
  rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 58 },
  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  emptyProvider: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 18 },
  identityActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  findingList: { gap: 10 },
  timelineContent: { padding: 15 },
  timelineRow: { flexDirection: 'row', gap: 10 },
  timelineRail: { width: 12, alignItems: 'center' },
  timelineDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  timelineLine: { width: 1, flex: 1, marginTop: 3 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  sheetContent: { padding: 20, paddingBottom: 34, gap: 15 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  sheetClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 12, padding: 10 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 3 },
});
