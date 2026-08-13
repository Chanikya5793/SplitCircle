export type SecurityIdentityType = 'email' | 'username' | 'phone' | 'domain';
export type SecurityFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type SecurityFindingState = 'active' | 'acknowledged' | 'remediated' | 'resolved' | 'muted';

export interface MonitoredSecurityIdentity {
  identityId: string;
  type: SecurityIdentityType;
  displayHint: string;
  verificationState: 'pending' | 'verified' | 'failed';
  verificationMethod: 'firebase_auth' | 'dns_txt' | 'manual_proof_required';
  verificationChallenge?: string;
  createdAt: number | null;
}

export interface SecurityRiskAssessment {
  score: number;
  severity: SecurityFindingSeverity;
  confidence: number;
  factors: Array<{ code: string; label: string; points: number }>;
  likelyRisks: Array<'credential_stuffing' | 'account_takeover' | 'targeted_phishing' | 'impersonation' | 'scam'>;
  recommendedActions: string[];
}

export interface SecurityFinding {
  findingId: string;
  identityId: string;
  identityHint: string;
  source: 'hibp' | 'flare' | 'google_web_risk' | 'manasplit';
  kind: 'breach' | 'paste' | 'infostealer' | 'credential_exposure' | 'phishing' | 'impersonation';
  title: string;
  summary: string;
  observedAt: number;
  occurredAt: number | null;
  exposedDataClasses: string[];
  evidence: Array<{ key: string; label: string; value: string }>;
  assessment: SecurityRiskAssessment;
  state: SecurityFindingState;
  occurrenceCount: number;
}

export interface SecurityProviderStatus {
  status: 'success' | 'not_configured' | 'unsupported_identity' | 'rate_limited' | 'partial' | 'failed';
  latencyMs: number;
  findingCount: number;
  checkedAt: number;
  message?: string;
}

export interface SecurityTimelineEvent {
  eventId: string;
  type: string;
  createdAt: number | null;
  findingId?: string;
  identityId?: string;
  findingCount?: number;
  newHighRiskCount?: number;
}

export interface SecurityCenterSnapshot {
  enabled: boolean;
  consentVersion: string | null;
  detailedNotifications: boolean;
  lastScanAt: number | null;
  nextScanAt: number | null;
  securityScore: number;
  providerStatus: Record<string, SecurityProviderStatus>;
  identities: MonitoredSecurityIdentity[];
  findings: SecurityFinding[];
  timeline: SecurityTimelineEvent[];
}

