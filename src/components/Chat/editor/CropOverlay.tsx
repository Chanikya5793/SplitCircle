import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

/**
 * Draggable crop rectangle drawn over the editor's canvas.
 *
 * Works entirely in DISPLAY (screen) coordinates and reports the result back
 * in the same space; the caller converts to image pixels using the one scale
 * factor it already owns. Keeping the conversion in a single place is
 * deliberate — a crop that is off by a scale factor is the classic way an
 * editor exports something that doesn't match its own preview.
 *
 * Geometry lives in Reanimated shared values rather than React state so the
 * drag runs on the UI thread. A crop handle updated through `setState` misses
 * frames on exactly the gesture where lag is most obvious.
 */

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropOverlayProps {
  /** Where the image is drawn on screen — the crop can never leave this. */
  frame: DisplayRect;
  /** Current crop in display coordinates. */
  value: DisplayRect;
  /** Locked width/height ratio, or null for a free crop. */
  aspect: number | null;
  onChange: (next: DisplayRect) => void;
}

const HANDLE = 28;
const MIN_SIZE = 56;

export const CropOverlay = ({ frame, value, aspect, onChange }: CropOverlayProps) => {
  const x = useSharedValue(value.x);
  const y = useSharedValue(value.y);
  const w = useSharedValue(value.width);
  const h = useSharedValue(value.height);

  // Gesture start snapshots, so each drag is relative to where it began
  // rather than accumulating rounding drift across many small deltas.
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startW = useSharedValue(0);
  const startH = useSharedValue(0);

  // The parent owns the rect (it resets on rotate, aspect change, etc.), so
  // adopt external changes rather than treating our copy as authoritative.
  useEffect(() => {
    x.value = value.x;
    y.value = value.y;
    w.value = value.width;
    h.value = value.height;
  }, [value.x, value.y, value.width, value.height, x, y, w, h]);

  const commit = () => {
    onChange({ x: x.value, y: y.value, width: w.value, height: h.value });
  };

  const panBody = Gesture.Pan()
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      // Clamp against the frame so the rect can be dragged to an edge and
      // stop there, rather than sliding off and snapping back on release.
      const nextX = startX.value + event.translationX;
      const nextY = startY.value + event.translationY;
      x.value = Math.min(Math.max(0, nextX), frame.width - w.value);
      y.value = Math.min(Math.max(0, nextY), frame.height - h.value);
    })
    .onEnd(() => {
      runOnJS(commit)();
    });

  /**
   * Build a corner handle. `dirX`/`dirY` say which edges this corner moves:
   * -1 means it drags the left/top edge (so the origin moves too), +1 means
   * it drags the right/bottom edge (origin fixed).
   */
  const cornerGesture = (dirX: -1 | 1, dirY: -1 | 1) =>
    Gesture.Pan()
      .onStart(() => {
        startX.value = x.value;
        startY.value = y.value;
        startW.value = w.value;
        startH.value = h.value;
      })
      .onUpdate((event) => {
        let nextW = startW.value + dirX * event.translationX;
        let nextH = startH.value + dirY * event.translationY;

        if (aspect !== null) {
          // Let the larger of the two drags lead, so a diagonal drag feels
          // like it follows the finger instead of fighting one axis.
          if (Math.abs(event.translationX) > Math.abs(event.translationY)) {
            nextH = nextW / aspect;
          } else {
            nextW = nextH * aspect;
          }
        }

        nextW = Math.max(MIN_SIZE, nextW);
        nextH = Math.max(MIN_SIZE, nextH);

        // A left/top handle keeps the OPPOSITE edge pinned, so the rect grows
        // away from the finger's anchor rather than jumping.
        let nextX = dirX === -1 ? startX.value + startW.value - nextW : startX.value;
        let nextY = dirY === -1 ? startY.value + startH.value - nextH : startY.value;

        // Constrain to the frame, re-deriving the pinned edge afterwards.
        if (nextX < 0) {
          nextW += nextX;
          nextX = 0;
          if (aspect !== null) nextH = nextW / aspect;
        }
        if (nextY < 0) {
          nextH += nextY;
          nextY = 0;
          if (aspect !== null) nextW = nextH * aspect;
        }
        if (nextX + nextW > frame.width) {
          nextW = frame.width - nextX;
          if (aspect !== null) nextH = nextW / aspect;
        }
        if (nextY + nextH > frame.height) {
          nextH = frame.height - nextY;
          if (aspect !== null) nextW = nextH * aspect;
        }

        x.value = nextX;
        y.value = nextY;
        w.value = Math.max(MIN_SIZE, nextW);
        h.value = Math.max(MIN_SIZE, nextH);
      })
      .onEnd(() => {
        runOnJS(commit)();
      });

  const rectStyle = useAnimatedStyle(() => ({
    left: x.value,
    top: y.value,
    width: w.value,
    height: h.value,
  }));

  // Four scrims rather than one path with a hole: keeps the dimming to plain
  // views that the crop rect can sit above, with no masking involved.
  const scrimTop = useAnimatedStyle(() => ({ height: y.value }));
  const scrimBottom = useAnimatedStyle(() => ({ top: y.value + h.value }));
  const scrimLeft = useAnimatedStyle(() => ({ top: y.value, height: h.value, width: x.value }));
  const scrimRight = useAnimatedStyle(() => ({
    top: y.value,
    height: h.value,
    left: x.value + w.value,
  }));

  return (
    <View
      style={[
        styles.root,
        { left: frame.x, top: frame.y, width: frame.width, height: frame.height },
      ]}
    >
      <Animated.View pointerEvents="none" style={[styles.scrim, styles.scrimFull, scrimTop]} />
      <Animated.View pointerEvents="none" style={[styles.scrim, styles.scrimFull, styles.scrimToBottom, scrimBottom]} />
      <Animated.View pointerEvents="none" style={[styles.scrim, scrimLeft]} />
      <Animated.View pointerEvents="none" style={[styles.scrim, styles.scrimToRight, scrimRight]} />

      <GestureDetector gesture={panBody}>
        <Animated.View style={[styles.rect, rectStyle]}>
          {/* Rule-of-thirds guides */}
          <View style={[styles.gridLine, styles.gridV, { left: '33.33%' }]} />
          <View style={[styles.gridLine, styles.gridV, { left: '66.66%' }]} />
          <View style={[styles.gridLine, styles.gridH, { top: '33.33%' }]} />
          <View style={[styles.gridLine, styles.gridH, { top: '66.66%' }]} />
        </Animated.View>
      </GestureDetector>

      {([
        [-1, -1, styles.handleTopLeft],
        [1, -1, styles.handleTopRight],
        [-1, 1, styles.handleBottomLeft],
        [1, 1, styles.handleBottomRight],
      ] as const).map(([dirX, dirY, cornerStyle], index) => (
        <CropHandle
          key={index}
          gesture={cornerGesture(dirX, dirY)}
          x={x}
          y={y}
          w={w}
          h={h}
          dirX={dirX}
          dirY={dirY}
          cornerStyle={cornerStyle}
        />
      ))}
    </View>
  );
};

interface CropHandleProps {
  gesture: ReturnType<typeof Gesture.Pan>;
  x: ReturnType<typeof useSharedValue<number>>;
  y: ReturnType<typeof useSharedValue<number>>;
  w: ReturnType<typeof useSharedValue<number>>;
  h: ReturnType<typeof useSharedValue<number>>;
  dirX: -1 | 1;
  dirY: -1 | 1;
  cornerStyle: object;
}

const CropHandle = ({ gesture, x, y, w, h, dirX, dirY, cornerStyle }: CropHandleProps) => {
  const style = useAnimatedStyle(() => ({
    left: (dirX === -1 ? x.value : x.value + w.value) - HANDLE / 2,
    top: (dirY === -1 ? y.value : y.value + h.value) - HANDLE / 2,
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.handle, style]} hitSlop={12}>
        <View style={[styles.handleMark, cornerStyle]} />
      </Animated.View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  root: { position: 'absolute' },
  scrim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  scrimFull: { left: 0, right: 0, top: 0 },
  scrimToBottom: { bottom: 0, height: undefined },
  scrimToRight: { right: 0, width: undefined },
  rect: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.95)',
  },
  gridLine: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.35)' },
  gridV: { top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
  gridH: { left: 0, right: 0, height: StyleSheet.hairlineWidth },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleMark: {
    width: 20,
    height: 20,
    borderColor: '#fff',
  },
  handleTopLeft: { borderLeftWidth: 3, borderTopWidth: 3 },
  handleTopRight: { borderRightWidth: 3, borderTopWidth: 3 },
  handleBottomLeft: { borderLeftWidth: 3, borderBottomWidth: 3 },
  handleBottomRight: { borderRightWidth: 3, borderBottomWidth: 3 },
});
