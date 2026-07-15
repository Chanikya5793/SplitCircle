// Prominent search button — the "search as a button, not a tab" pattern Apple's
// Phone app uses (WWDC26 "Design intuitive search experiences"): a detached, glass
// circle sitting BESIDE the tab bar. Tapping it engages search immediately (the
// field is focused and the keyboard comes up on arrival) rather than dropping you
// on a browse-first landing page. Use it when people usually know what they're
// looking for — which is us: find a group/expense/person fast.
//
// Why this is our own view instead of a real `UISearchTab`: react-native-screens
// builds the native tab bar with the legacy UITabBarController `viewControllers` +
// `tabBarItem` API and has no `UISearchTab` (its `tabBarSystemItem: 'search'` only
// borrows the system ICON, which is why search rendered as a plain 5th tab). The
// iOS 18+ `UITab`/`UISearchTab` API the detached button needs isn't adopted there,
// so we render the affordance ourselves. See ai_layer/docs or DESIGN.md notes.
//
// Positioning is derived from tabBarMetrics so it tracks the tab bar's envelope;
// it's a sibling of the tab navigator (not inside a tab screen) so it paints above
// the native tab bar.

import { ROUTES } from '@/constants/routes';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  FLOATING_TAB_BAR_HEIGHT,
  getFloatingTabBarBottomOffset,
} from './tabBarMetrics';

/** Matches the Phone app's search circle — roughly the tab bar's inner height. */
const SIZE = 56;
const EDGE_INSET = 14;

export const ProminentSearchButton = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();

  // Vertically centre the circle against the floating tab bar's envelope.
  const bottom =
    getFloatingTabBarBottomOffset(insets.bottom) + (FLOATING_TAB_BAR_HEIGHT - SIZE) / 2;

  return (
    // box-none: the wrapper must never swallow taps meant for the tab bar/content.
    <View pointerEvents="box-none" style={[styles.wrap, { bottom, right: EDGE_INSET }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search"
        hitSlop={8}
        onPress={() => {
          lightHaptic();
          navigation.navigate(ROUTES.APP.SEARCH);
        }}
        style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
      >
        <BlurView
          intensity={20}
          tint={isDark ? 'dark' : 'light'}
          style={[
            styles.glass,
            {
              backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)',
              borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.06)',
            },
          ]}
        >
          <Ionicons name="search" size={22} color={theme.colors.onSurface} />
        </BlurView>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { position: 'absolute' },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    // Lift it off the content the same way the native floating bar reads.
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  glass: {
    flex: 1,
    borderRadius: SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
