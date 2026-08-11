// Dissolves scrolling content before it reaches the status bar.
//
// THE PROBLEM (doc 37 §13.3). Content passing under the floating chrome is a
// deliberate choice in this app, and it works everywhere it has something
// behind it — the header pills stay perfectly legible because they carry
// glass. The status bar is the one strip with nothing behind it, so scrolled
// content lands on the clock, wifi and battery glyphs at full opacity and both
// become unreadable. That is an OCCUPANCY problem, not a contrast one: two
// sets of text in the same pixels. No colour or style change can fix it.
//
// THE FIX. Ramp the content's alpha to zero over the status-bar band. Content
// still travels under the chrome — it just stops existing before it arrives.
// Nothing is added on top, so no band appears and there is no new surface to
// classify as a SurfaceRole.
//
// WHY A MASK AND NOT A GRADIENT. A LinearGradient painted over the top would
// have to be opaque in the app's background colour to hide anything, which
// also hides the LiquidBackground blobs (or a photo wallpaper) behind it — a
// visible flat band at the top, i.e. a worse version of the alternative this
// deliberately isn't. Only an alpha mask removes the CONTENT while leaving the
// BACKDROP untouched.
//
// NOT the iOS 26 scroll-edge effect. That is deliberately patched OUT
// (`patches/react-native+0.83.2.patch`) because it fogged the full scroll edge
// over the colourful backdrops. This is the same mechanism at a fraction of
// the scope — the status strip only — and the patch must stay removed.
//
// ⚠️ THE RISK TO VERIFY ON A DEVICE, BEFORE TRUSTING THIS ANYWHERE.
// DESIGN.md's native-material kill list says the iOS 26 glass material drops
// out (renders as NOTHING) under an ancestor with fractional opacity, because
// that forces offscreen compositing and kills UIVisualEffectView. A mask is a
// different property but the same class of operation, so it may kill it too.
// Any `role="glass"` hero card inside a masked ScrollView — GroupDetailsScreen
// has two, the balances block and "who owes whom" — is what to look at first.
// If they lose their material, this approach conflicts with the app's glass
// DNA on iOS and the honest answer is the status-bar backing instead, NOT
// papering over it with `forceBlur` (DESIGN.md: forceBlur rows visibly do not
// match native-glass cards on the same screen). Android is unaffected either
// way — it has no native material and `fadingEdgeLength` needs no mask at all.

import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface TopEdgeFadeProps {
  children: React.ReactNode;
  /**
   * Height of the ramp. Defaults to the top safe-area inset — exactly the
   * strip the system glyphs occupy, and no more. Pass a number only to opt a
   * screen out of that default deliberately.
   */
  height?: number;
  /** Set false to render children untouched (e.g. a screen that never scrolls under). */
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const TopEdgeFade = ({ children, height, enabled = true, style }: TopEdgeFadeProps) => {
  const insets = useSafeAreaInsets();
  // Fall back to a sane strip on devices reporting no inset (older hardware,
  // and the Android status bar when the inset is not surfaced).
  const band = height ?? Math.max(insets.top, 24);

  if (!enabled || band <= 0) {
    return <View style={[styles.fill, style]}>{children}</View>;
  }

  return (
    <MaskedView
      style={[styles.fill, style]}
      // The mask is read by ALPHA: a fixed `band`-tall ramp from transparent to
      // opaque, then solid for the rest of the screen. It must be a column of
      // two elements — a full-height gradient would dim real content all the
      // way down instead of only the strip.
      maskElement={
        <View style={styles.fill}>
          <LinearGradient
            style={{ height: band }}
            colors={['transparent', 'rgba(0,0,0,0.55)', '#000']}
            locations={[0, 0.55, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
          />
          <View style={styles.maskSolid} />
        </View>
      }
    >
      {children}
    </MaskedView>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Below the ramp the mask must be fully opaque, or the whole screen dims.
  maskSolid: { flex: 1, backgroundColor: '#000' },
});

/**
 * Android has this built in — `fadingEdgeLength` on ScrollView/FlatList is a
 * native ScrollView fading edge (`@platform android` in RN's own types). It is
 * cheaper than a mask and visually equivalent, so screens may prefer it there
 * and use TopEdgeFade only on iOS. Exported so call sites don't re-derive the
 * platform check.
 */
export const topEdgeFadeProps = (band: number) =>
  Platform.OS === 'android' ? { fadingEdgeLength: band } : {};
