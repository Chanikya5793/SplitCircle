import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ protectedIds: new Set<string>(), duress: false, seen: [] as any[] }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { userId: 'me' } }) }));
vi.mock('@/context/GroupContext', () => ({ useGroups: () => ({ loading: false, groups: [{ groupId: 'visible' }, { groupId: 'protected' }, { groupId: 'hidden', hidden: true }] }) }));
vi.mock('@/context/PrivacyGuardContext', () => ({ usePrivacyGuard: () => ({ isShielded: (_target: string, id: string) => state.protectedIds.has(id), isVanished: () => false, duress: state.duress }) }));
vi.mock('@/context/ThemeContext', () => ({ useTheme: () => ({ theme: { colors: {}, spacing: { md: 16, xs: 4 }, typography: { headline: {}, body: {} } } }) }));
vi.mock('react-native-paper', () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/utils/myBalance', () => ({
  computeOverallBalance: (_user: string, groups: any[]) => { state.seen = groups; return groups; },
  splitOwedAndOwing: (groups: any[]) => ({ owed: groups.length ? [{ amount: groups.length * 10, currency: 'USD' }] : [], owing: [] }),
}));
import { BalanceHeadline } from '../BalanceHeadline';
afterEach(() => { cleanup(); state.protectedIds.clear(); state.duress = false; });
it('excludes protected and hidden groups from prominent balances', () => {
  state.protectedIds.add('protected');
  render(<BalanceHeadline prominent />);
  expect(state.seen.map(g => g.groupId)).toEqual(['visible']);
  expect(screen.getByText('$10.00')).toBeTruthy();
});
it('adds up the decoy rows in the duress world instead of claiming settled', () => {
  // useGroups already hands over the disguised (scaled) groups in duress, so
  // the headline must total them — "all settled up" above rows that each show
  // money owed would give the fake unlock away.
  state.protectedIds = new Set(['visible', 'protected']); state.duress = true;
  render(<BalanceHeadline prominent />);
  expect(state.seen.map(g => g.groupId)).toEqual(['visible', 'protected']);
  expect(screen.queryByText("You're all settled up")).toBeNull();
});
it('avoids a false settled claim when every scoped balance is locked', () => {
  state.protectedIds = new Set(['visible', 'protected']);
  const view = render(<BalanceHeadline />);
  expect(view.container.textContent).toBe('');
});
