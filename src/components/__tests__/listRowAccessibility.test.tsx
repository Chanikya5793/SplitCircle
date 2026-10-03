import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/context/ThemeContext', () => ({ useTheme: () => ({ theme: { fontScale: 2, colors: {}, spacing: { md: 16, sm: 8 }, radius: { pill: 999 }, typography: { body: { fontSize: 15, lineHeight: 40 }, caption: { fontSize: 13, lineHeight: 36 } } } }) }));
vi.mock('@/hooks/usePressFeedback', () => ({ usePressFeedback: () => ({ touchableProps: {}, pressScaleStyle: {}, pressHighlightStyle: {} }) }));
vi.mock('react-native-reanimated', async () => { const { View } = await import('react-native'); return { default: { View } }; });
vi.mock('react-native-paper', () => ({
  Icon: () => null,
  Text: ({ children, numberOfLines }: any) => <span data-line-limit={numberOfLines}>{children}</span>,
  TouchableRipple: ({ children, onPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
}));
import { ListRow } from '../ui/ListRow';
afterEach(cleanup);
it('keeps long labels untruncated and the full row toggling its setting', () => {
  const changed = vi.fn();
  const SwitchStub = (_props: any) => <span>Switch</span>;
  render(<ListRow title="Require confirmation before recording a settlement" subtitle="A long explanation that must remain readable at large text sizes" trailing={<SwitchStub value={false} onValueChange={changed} />} />);
  expect(screen.getByText('Require confirmation before recording a settlement').getAttribute('data-line-limit')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  expect(changed).toHaveBeenCalledWith(true);
});
it('keeps explicit navigation separate from a trailing toggle', () => {
  const navigate = vi.fn(); const changed = vi.fn();
  const SwitchStub = (_props: any) => <span>Switch</span>;
  render(<ListRow title="Options" onPress={navigate} trailing={<SwitchStub value onValueChange={changed} />} />);
  fireEvent.click(screen.getByRole('button'));
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
});
