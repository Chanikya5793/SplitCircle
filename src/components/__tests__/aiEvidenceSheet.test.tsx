import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/GlassView', () => ({
  GlassView: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      colors: {
        onSurface: '#111', onSurfaceVariant: '#555', primary: '#06c', outlineVariant: '#ccc',
      },
    },
  }),
}));
vi.mock('@/utils/haptics', () => ({ lightHaptic: vi.fn() }));
vi.mock('react-native-paper', () => ({
  Icon: ({ source }: { source: string }) => React.createElement('span', { 'aria-label': `icon-${source}` }),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
}));

import { AiEvidenceSheet } from '../ai/AiEvidenceSheet';

afterEach(cleanup);

describe('AiEvidenceSheet', () => {
  it('shows the actual engine inline and discloses capability privacy details on tap', () => {
    render(
      <AiEvidenceSheet
        engine="pcc"
        capabilities={[{
          kind: 'capability', tool: 'balances', version: 1, title: 'Balances',
          dataClasses: ['persistent_money'],
        }]}
      />,
    );

    expect(screen.getByText('Private Cloud · How this was answered')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('How this answer was produced'));
    expect(screen.getByText(/Private Cloud Compute worded the answer/)).toBeTruthy();
    expect(screen.getByText('Balances')).toBeTruthy();
    expect(screen.getByText(/Expense and balance data · contract v1/)).toBeTruthy();
  });

  it('renders typed expense evidence and opens the selected expense', () => {
    const onOpenExpense = vi.fn();
    render(
      <AiEvidenceSheet
        engine="deterministic"
        fallbackCurrency="USD"
        sources={[{
          expenseId: 'e1', groupId: 'g1', title: 'Dinner', category: 'Food', amount: 42, currency: 'USD',
        }]}
        onOpenExpense={onOpenExpense}
      />,
    );

    expect(screen.getByText('Exact calculation · How this was answered')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('How this answer was produced'));
    expect(screen.getByText('Expense evidence')).toBeTruthy();
    expect(screen.getByText('Dinner')).toBeTruthy();
    expect(screen.getByText('Food')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Open Dinner'));
    expect(onOpenExpense).toHaveBeenCalledWith(expect.objectContaining({ expenseId: 'e1' }));
  });

  it('does not render a disclosure control when no provenance exists', () => {
    const { container } = render(<AiEvidenceSheet />);
    expect(container.textContent).toBe('');
  });
});
