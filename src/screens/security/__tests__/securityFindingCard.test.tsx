import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const analyst = vi.hoisted(() => ({ explain: vi.fn() }));

vi.mock('@/components/ui', () => ({
  GlassCard: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      colors: {
        danger: '#c00', dangerContainer: '#fee', warning: '#a60', warningContainer: '#ffe',
        primary: '#06c', primaryContainer: '#eef', success: '#070', successContainer: '#efe',
        onSurface: '#111', onSurfaceVariant: '#555', outlineVariant: '#ccc',
      },
    },
  }),
}));
vi.mock('@/utils/haptics', () => ({ lightHaptic: vi.fn() }));
vi.mock('@/services/securityAnalystService', () => ({ explainSecurityFinding: analyst.explain }));
vi.mock('react-native-paper', () => ({
  ActivityIndicator: () => React.createElement('span', null, 'busy'),
  Icon: ({ source }: { source: string }) => React.createElement('span', { 'aria-label': `icon-${source}` }),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
  Button: ({ children, onPress, disabled }: { children?: React.ReactNode; onPress?: () => void; disabled?: boolean }) =>
    React.createElement('button', { onClick: onPress, disabled }, children),
}));

import type { SecurityFinding } from '@/models/security';
import { SecurityFindingCard } from '../SecurityFindingCard';

const finding: SecurityFinding = {
  findingId: 'f1', identityId: 'i1', identityHint: 'o•••@example.com', source: 'hibp',
  kind: 'breach', title: 'Example breach', summary: 'The monitored email matched.',
  observedAt: 1, occurredAt: 1, exposedDataClasses: ['Passwords'],
  evidence: [{ key: 'domain', label: 'Affected service', value: 'google.com' }],
  assessment: {
    score: 68, severity: 'high', confidence: 0.94,
    factors: [{ code: 'password', label: 'Password data exposed', points: 26 }],
    likelyRisks: ['credential_stuffing'],
    recommendedActions: ['Change the affected password.'],
  },
  state: 'active', occurrenceCount: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SecurityFindingCard', () => {
  it('expands evidence and records acknowledgement through the server callback', async () => {
    const onStateChange = vi.fn(async () => undefined);
    render(<SecurityFindingCard finding={finding} onStateChange={onStateChange} onDelete={vi.fn()} />);

    expect(screen.queryByText('Safe evidence')).toBeNull();
    fireEvent.click(screen.getByLabelText('high severity: Example breach'));
    expect(screen.getByText('Safe evidence')).toBeTruthy();
    expect(screen.getByText('Password data exposed')).toBeTruthy();
    expect(screen.getByText('Open official security page')).toBeTruthy();

    fireEvent.click(screen.getByText('Acknowledge'));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith('acknowledged'));
  });

  it('discloses the actual AI engine and preserves evidence citations', async () => {
    analyst.explain.mockResolvedValueOnce({
      source: 'ondevice',
      text: 'Password exposure is the strongest factor. [F1]',
      citedEvidenceIds: ['F1'],
    });
    render(<SecurityFindingCard finding={finding} onStateChange={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('high severity: Example breach'));
    fireEvent.click(screen.getByText('Explain with AI'));

    expect(await screen.findByText('On-device explanation')).toBeTruthy();
    expect(screen.getByText('Password exposure is the strongest factor. [F1]')).toBeTruthy();
  });

  it('exposes explicit deletion without conflating it with mute or remediation', () => {
    const onDelete = vi.fn();
    render(<SecurityFindingCard finding={finding} onStateChange={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText('high severity: Example breach'));
    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
