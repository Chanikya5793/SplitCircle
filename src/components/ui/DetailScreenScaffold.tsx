import { useHeaderHeight } from '@react-navigation/elements';
import React, { forwardRef } from 'react';
import { RefreshControl, ScrollView, type ScrollViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/context/ThemeContext';
import { TopEdgeFade } from './TopEdgeFade';
import { readableHorizontalInsets, SCREEN_GUTTER } from './layout';

export interface DetailScreenScaffoldProps extends ScrollViewProps {
  /** Extra space above the bottom safe area. Defaults to the shared large gap. */
  bottomSpacing?: number;
  /**
   * Readable inset inside the left/right safe areas. Defaults to the standard
   * screen gutter; pass 0 only for content that is intentionally edge-to-edge.
   */
  horizontalInset?: number;
}

/** Scroll shell for full-screen content behind a transparent native header.
 * Keep LiquidBackground and privacy guards outside; sheets and overlays stay
 * siblings. This component alone owns header clearance and system insets.
 */
export const DetailScreenScaffold = forwardRef<ScrollView, DetailScreenScaffoldProps>(
  function DetailScreenScaffold({ children, contentContainerStyle, bottomSpacing,
    horizontalInset = SCREEN_GUTTER, refreshControl, scrollIndicatorInsets, ...props }, ref) {
    const headerHeight = useHeaderHeight();
    const insets = useSafeAreaInsets();
    const { theme } = useTheme();
    const top = headerHeight + theme.spacing.lg;
    const refresh = refreshControl?.type === RefreshControl
      ? React.cloneElement(refreshControl, { progressViewOffset: top })
      : refreshControl;

    return (
      <TopEdgeFade height={headerHeight} ramp={theme.spacing.lg}>
        <ScrollView
          {...props}
          ref={ref}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          automaticallyAdjustsScrollIndicatorInsets={false}
          scrollIndicatorInsets={{ ...scrollIndicatorInsets, top: headerHeight, bottom: insets.bottom }}
          refreshControl={refresh}
          contentContainerStyle={[
            contentContainerStyle,
            {
              paddingTop: top,
              paddingBottom: insets.bottom + (bottomSpacing ?? theme.spacing.xl),
              ...readableHorizontalInsets(insets.left, insets.right, horizontalInset),
            },
          ]}
        >
          {children}
        </ScrollView>
      </TopEdgeFade>
    );
  },
);
