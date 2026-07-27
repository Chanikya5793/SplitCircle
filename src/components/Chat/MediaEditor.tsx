import { GlassCard } from '@/components/ui/GlassCard';
import { useTheme } from '@/context/ThemeContext';
import { loadSkiaImage, renderEditedImage } from '@/services/mediaEditorRender';
import { appAlert } from '@/utils/appAlert';
import type { Adjustments } from '@/utils/colorMatrix';
import { FILTER_PRESETS, IDENTITY_MATRIX } from '@/utils/colorMatrix';
import type { CropRect, DrawStroke, EditorState } from '@/utils/mediaEditorGeometry';
import {
  clampCrop,
  createInitialEditorState,
  effectiveColorMatrix,
  fitAspectRect,
  isEditorStateNeutral,
  rotatedBounds,
  totalRotationDegrees,
} from '@/utils/mediaEditorGeometry';
import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import {
  Canvas,
  ColorMatrix,
  Group,
  Image as SkiaImage,
  Path as SkiaPath,
  type SkImage,
} from '@shopify/react-native-skia';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CropOverlay, type DisplayRect } from './editor/CropOverlay';

/**
 * Full-screen photo editor: crop, straighten, rotate, flip, filters, manual
 * adjustments and freehand markup.
 *
 * One Skia canvas drives every tool. The alternative — `expo-image-manipulator`
 * for geometry plus something else for colour — cannot work here: it has no
 * colour operations at all, and chaining separate passes would re-encode the
 * photo once per tool, stacking JPEG generations on an image the user is
 * actively trying to improve. Here the preview is a live render of the same
 * state the exporter consumes, and Done is the single encode.
 *
 * Export deliberately does NOT snapshot this on-screen canvas — see
 * `mediaEditorRender.ts` for why (it would silently downscale to screen size).
 */

type Tool = 'crop' | 'adjust' | 'filter' | 'draw';

const ASPECT_PRESETS: { id: string; label: string; value: number | null }[] = [
  { id: 'free', label: 'Free', value: null },
  { id: 'square', label: '1:1', value: 1 },
  { id: 'four-three', label: '4:3', value: 4 / 3 },
  { id: 'three-four', label: '3:4', value: 3 / 4 },
  { id: 'sixteen-nine', label: '16:9', value: 16 / 9 },
  { id: 'nine-sixteen', label: '9:16', value: 9 / 16 },
];

const PEN_COLORS = ['#FF3B30', '#FFCC00', '#34C759', '#0A84FF', '#FFFFFF', '#000000'];

interface MediaEditorProps {
  visible: boolean;
  /** Source image URI. Must be a decodable still — callers gate on type. */
  uri: string;
  onCancel: () => void;
  /** Receives the edited file. Not called when nothing was changed. */
  onDone: (result: { uri: string; width: number; height: number }) => void;
}

export const MediaEditor = ({ visible, uri, onCancel, onDone }: MediaEditorProps) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const [image, setImage] = useState<SkImage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tool, setTool] = useState<Tool>('crop');
  const [state, setState] = useState<EditorState>(createInitialEditorState);
  const [aspectId, setAspectId] = useState('free');
  const [filterId, setFilterId] = useState('none');
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penWidth, setPenWidth] = useState(0.012);
  const [liveStroke, setLiveStroke] = useState<string | null>(null);

  const liveStrokeRef = useRef<string | null>(null);

  // Decode once per source. Skia images are native resources, so re-decoding
  // on every render would leak them and stall the UI thread on a 12MP photo.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setImage(null);
    setLoadError(null);
    setState(createInitialEditorState());
    setAspectId('free');
    setFilterId('none');
    setTool('crop');

    loadSkiaImage(uri)
      .then((img) => {
        if (!cancelled) setImage(img);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Could not open this image.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [visible, uri]);

  const sourceWidth = image?.width() ?? 0;
  const sourceHeight = image?.height() ?? 0;
  const degrees = totalRotationDegrees(state);
  const bounds = useMemo(
    () => rotatedBounds(sourceWidth, sourceHeight, degrees),
    [sourceWidth, sourceHeight, degrees],
  );

  // The crop, resolved — an unset crop means the whole rotated image.
  const crop: CropRect = useMemo(
    () => state.crop ?? { x: 0, y: 0, width: bounds.width, height: bounds.height },
    [state.crop, bounds.width, bounds.height],
  );

  const stageHeight = Math.max(
    200,
    screenH - insets.top - insets.bottom - 64 /* header */ - 190 /* controls */,
  );
  const stageWidth = screenW;

  // In Crop the whole rotated image must be reachable, so the full bounds are
  // fitted. Every other tool shows the cropped result — you judge a filter on
  // the photo you are actually sending, not on material you cropped away.
  const fitTarget = tool === 'crop' ? bounds : { width: crop.width, height: crop.height };
  const scale = useMemo(() => {
    if (!fitTarget.width || !fitTarget.height) return 1;
    return Math.min(stageWidth / fitTarget.width, stageHeight / fitTarget.height);
  }, [fitTarget.width, fitTarget.height, stageWidth, stageHeight]);

  const displayW = fitTarget.width * scale;
  const displayH = fitTarget.height * scale;
  const offsetX = (stageWidth - displayW) / 2;
  const offsetY = (stageHeight - displayH) / 2;

  const matrix = useMemo(() => effectiveColorMatrix(state), [state]);

  // Same chain as the exporter, read bottom-up, with the display scale in
  // front and the crop offset applied only when we are showing the result.
  const groupTransform = useMemo(() => {
    const radians = (degrees * Math.PI) / 180;
    return [
      { scale },
      ...(tool === 'crop'
        ? []
        : [{ translateX: -crop.x }, { translateY: -crop.y }]),
      { translateX: bounds.width / 2 },
      { translateY: bounds.height / 2 },
      { rotate: radians },
      { scaleX: state.flipHorizontal ? -1 : 1 },
      { translateX: -sourceWidth / 2 },
      { translateY: -sourceHeight / 2 },
    ];
  }, [scale, tool, crop.x, crop.y, bounds.width, bounds.height, degrees, state.flipHorizontal, sourceWidth, sourceHeight]);

  const cropDisplayRect: DisplayRect = useMemo(
    () => ({
      x: crop.x * scale,
      y: crop.y * scale,
      width: crop.width * scale,
      height: crop.height * scale,
    }),
    [crop.x, crop.y, crop.width, crop.height, scale],
  );

  const handleCropChange = useCallback(
    (next: DisplayRect) => {
      setState((prev) => ({
        ...prev,
        crop: clampCrop(
          {
            x: next.x / scale,
            y: next.y / scale,
            width: next.width / scale,
            height: next.height / scale,
          },
          bounds,
        ),
      }));
    },
    [scale, bounds],
  );

  const applyAspect = useCallback(
    (id: string, value: number | null) => {
      setAspectId(id);
      if (value === null) return;
      setState((prev) => ({ ...prev, crop: fitAspectRect(bounds, value) }));
    },
    [bounds],
  );

  const rotateQuarter = useCallback(() => {
    // The crop is expressed in rotated space, so a turn invalidates it. Reset
    // rather than trying to carry it across — a rect that "survives" a
    // rotation lands somewhere the user never chose.
    setState((prev) => ({
      ...prev,
      rotationQuarters: (prev.rotationQuarters + 1) % 4,
      crop: null,
    }));
    setAspectId('free');
  }, []);

  const setStraighten = useCallback((value: number) => {
    setState((prev) => ({ ...prev, straightenDeg: value, crop: null }));
  }, []);

  const setAdjustment = useCallback((key: keyof Adjustments, value: number) => {
    setState((prev) => ({ ...prev, adjustments: { ...prev.adjustments, [key]: value } }));
  }, []);

  const applyFilter = useCallback((id: string) => {
    const preset = FILTER_PRESETS.find((p) => p.id === id);
    setFilterId(id);
    setState((prev) => ({ ...prev, presetMatrix: preset?.matrix ?? IDENTITY_MATRIX }));
  }, []);

  const resetAll = useCallback(() => {
    setState(createInitialEditorState());
    setAspectId('free');
    setFilterId('none');
  }, []);

  // Freehand markup. Points are normalised against the displayed crop rect, so
  // a stroke drawn here lands in the same place at full export resolution.
  const drawGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(tool === 'draw')
        .minDistance(0)
        .onBegin((event) => {
          const nx = (event.x / displayW).toFixed(5);
          const ny = (event.y / displayH).toFixed(5);
          liveStrokeRef.current = `M${nx} ${ny}`;
          setLiveStroke(liveStrokeRef.current);
        })
        .onUpdate((event) => {
          if (!liveStrokeRef.current) return;
          const nx = (event.x / displayW).toFixed(5);
          const ny = (event.y / displayH).toFixed(5);
          liveStrokeRef.current = `${liveStrokeRef.current} L${nx} ${ny}`;
          setLiveStroke(liveStrokeRef.current);
        })
        .onFinalize(() => {
          const d = liveStrokeRef.current;
          liveStrokeRef.current = null;
          setLiveStroke(null);
          // A tap with no drag produces a single moveto, which draws nothing —
          // storing it would make Undo appear broken.
          if (!d || !d.includes('L')) return;
          setState((prev) => ({
            ...prev,
            strokes: [...prev.strokes, { d, color: penColor, widthFraction: penWidth }],
          }));
        })
        .runOnJS(true),
    [tool, displayW, displayH, penColor, penWidth],
  );

  const undoStroke = useCallback(() => {
    setState((prev) => ({ ...prev, strokes: prev.strokes.slice(0, -1) }));
  }, []);

  const handleDone = useCallback(async () => {
    if (!image) return;
    // Nothing changed: hand back the original so the user doesn't pay a
    // re-encode generation for opening the editor and looking around.
    if (isEditorStateNeutral(state)) {
      onCancel();
      return;
    }
    setExporting(true);
    try {
      const result = await renderEditedImage(image, state);
      onDone(result);
    } catch (error) {
      console.error('Media edit export failed:', error);
      appAlert(
        'Could not save your edits',
        error instanceof Error ? error.message : 'Please try again.',
      );
    } finally {
      setExporting(false);
    }
  }, [image, state, onDone, onCancel]);

  const strokePaths = useMemo(() => {
    const all = [...state.strokes];
    if (liveStroke) all.push({ d: liveStroke, color: penColor, widthFraction: penWidth });
    return all;
  }, [state.strokes, liveStroke, penColor, penWidth]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <GestureHandlerRootView style={styles.root}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onCancel} hitSlop={12} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>Cancel</Text>
          </Pressable>
          <Pressable onPress={resetAll} hitSlop={12} style={styles.headerButton}>
            <Text style={styles.headerResetText}>Reset</Text>
          </Pressable>
          <Pressable
            onPress={handleDone}
            hitSlop={12}
            disabled={!image || exporting}
            style={styles.headerButton}
          >
            {exporting ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <Text style={[styles.headerButtonText, styles.headerDone, { color: theme.colors.primary }]}>
                Done
              </Text>
            )}
          </Pressable>
        </View>

        <View style={[styles.stage, { height: stageHeight }]}>
          {loadError ? (
            <View style={styles.centered}>
              <Ionicons name="image-outline" size={40} color="rgba(255,255,255,0.6)" />
              <Text style={styles.errorText}>{loadError}</Text>
            </View>
          ) : !image ? (
            <View style={styles.centered}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : (
            <GestureDetector gesture={drawGesture}>
              <View style={StyleSheet.absoluteFill}>
                <Canvas style={{ width: stageWidth, height: stageHeight }}>
                  <Group
                    transform={[{ translateX: offsetX }, { translateY: offsetY }]}
                    clip={{ x: 0, y: 0, width: displayW, height: displayH }}
                  >
                    <Group transform={groupTransform}>
                      <SkiaImage
                        image={image}
                        x={0}
                        y={0}
                        width={sourceWidth}
                        height={sourceHeight}
                        fit="fill"
                      >
                        <ColorMatrix matrix={matrix} />
                      </SkiaImage>
                    </Group>
                    {/* Markup sits outside the photo transform — annotations
                        must not rotate or take on the photo's colour grade. */}
                    {tool !== 'crop' &&
                      strokePaths.map((stroke, index) => (
                        <SkiaPath
                          key={index}
                          path={scaleStrokePath(stroke, displayW, displayH)}
                          color={stroke.color}
                          style="stroke"
                          strokeWidth={Math.max(
                            1,
                            stroke.widthFraction * Math.max(displayW, displayH),
                          )}
                          strokeCap="round"
                          strokeJoin="round"
                        />
                      ))}
                  </Group>
                </Canvas>

                {tool === 'crop' ? (
                  <CropOverlay
                    frame={{ x: offsetX, y: offsetY, width: displayW, height: displayH }}
                    value={cropDisplayRect}
                    aspect={ASPECT_PRESETS.find((a) => a.id === aspectId)?.value ?? null}
                    onChange={handleCropChange}
                  />
                ) : null}
              </View>
            </GestureDetector>
          )}
        </View>

        <View style={[styles.controls, { paddingBottom: insets.bottom + 8 }]}>
          <GlassCard style={styles.controlCard} contentStyle={styles.controlCardContent}>
            {tool === 'crop' ? (
              <CropControls
                aspectId={aspectId}
                onAspect={applyAspect}
                onRotate={rotateQuarter}
                onFlip={() => setState((p) => ({ ...p, flipHorizontal: !p.flipHorizontal }))}
                straighten={state.straightenDeg}
                onStraighten={setStraighten}
                primary={theme.colors.primary}
              />
            ) : null}

            {tool === 'adjust' ? (
              <AdjustControls
                adjustments={state.adjustments}
                onChange={setAdjustment}
                primary={theme.colors.primary}
              />
            ) : null}

            {tool === 'filter' ? (
              <FilterControls selected={filterId} onSelect={applyFilter} primary={theme.colors.primary} />
            ) : null}

            {tool === 'draw' ? (
              <DrawControls
                penColor={penColor}
                onPenColor={setPenColor}
                penWidth={penWidth}
                onPenWidth={setPenWidth}
                canUndo={state.strokes.length > 0}
                onUndo={undoStroke}
                primary={theme.colors.primary}
              />
            ) : null}
          </GlassCard>

          <View style={styles.toolbar}>
            {([
              ['crop', 'crop-outline', 'Crop'],
              ['adjust', 'options-outline', 'Adjust'],
              ['filter', 'color-filter-outline', 'Filters'],
              ['draw', 'brush-outline', 'Draw'],
            ] as const).map(([id, icon, label]) => (
              <Pressable
                key={id}
                onPress={() => setTool(id)}
                style={styles.toolButton}
                accessibilityRole="button"
                accessibilityState={{ selected: tool === id }}
                accessibilityLabel={label}
              >
                <Ionicons
                  name={icon}
                  size={22}
                  color={tool === id ? theme.colors.primary : 'rgba(255,255,255,0.7)'}
                />
                <Text
                  style={[
                    styles.toolLabel,
                    tool === id && { color: theme.colors.primary, fontWeight: '700' },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};

/** Strokes are stored normalised 0–1; expand them into the current display box. */
const scaleStrokePath = (stroke: DrawStroke, width: number, height: number): string =>
  stroke.d.replace(/([ML])([\d.]+) ([\d.]+)/g, (_all, cmd: string, sx: string, sy: string) =>
    `${cmd}${(parseFloat(sx) * width).toFixed(2)} ${(parseFloat(sy) * height).toFixed(2)}`,
  );

// ─── Control panels ─────────────────────────────────────────────────────────

const CropControls = ({
  aspectId,
  onAspect,
  onRotate,
  onFlip,
  straighten,
  onStraighten,
  primary,
}: {
  aspectId: string;
  onAspect: (id: string, value: number | null) => void;
  onRotate: () => void;
  onFlip: () => void;
  straighten: number;
  onStraighten: (value: number) => void;
  primary: string;
}) => (
  <View style={styles.panel}>
    <View style={styles.rowBetween}>
      <Pressable onPress={onRotate} style={styles.iconAction} accessibilityLabel="Rotate 90 degrees">
        <Ionicons name="refresh-outline" size={20} color="#fff" />
        <Text style={styles.iconActionText}>Rotate</Text>
      </Pressable>
      <View style={styles.straightenWrap}>
        <Text style={styles.sliderLabel}>Straighten {straighten.toFixed(0)}°</Text>
        <Slider
          style={styles.slider}
          minimumValue={-45}
          maximumValue={45}
          step={1}
          value={straighten}
          onValueChange={onStraighten}
          minimumTrackTintColor={primary}
          maximumTrackTintColor="rgba(255,255,255,0.25)"
          thumbTintColor={primary}
        />
      </View>
      <Pressable onPress={onFlip} style={styles.iconAction} accessibilityLabel="Flip horizontally">
        <Ionicons name="swap-horizontal-outline" size={20} color="#fff" />
        <Text style={styles.iconActionText}>Flip</Text>
      </Pressable>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {ASPECT_PRESETS.map((preset) => (
        <Pressable
          key={preset.id}
          onPress={() => onAspect(preset.id, preset.value)}
          style={[styles.chip, aspectId === preset.id && { backgroundColor: primary }]}
        >
          <Text style={styles.chipText}>{preset.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  </View>
);

const ADJUSTMENTS: { key: keyof Adjustments; label: string }[] = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'warmth', label: 'Warmth' },
];

const AdjustControls = ({
  adjustments,
  onChange,
  primary,
}: {
  adjustments: Adjustments;
  onChange: (key: keyof Adjustments, value: number) => void;
  primary: string;
}) => (
  <ScrollView style={styles.panel} showsVerticalScrollIndicator={false}>
    {ADJUSTMENTS.map(({ key, label }) => (
      <View key={key} style={styles.sliderRow}>
        <Text style={styles.sliderLabel}>
          {label} {adjustments[key] === 0 ? '' : `${adjustments[key] > 0 ? '+' : ''}${Math.round(adjustments[key] * 100)}`}
        </Text>
        <Slider
          style={styles.slider}
          minimumValue={-1}
          maximumValue={1}
          step={0.01}
          value={adjustments[key]}
          onValueChange={(value) => onChange(key, value)}
          minimumTrackTintColor={primary}
          maximumTrackTintColor="rgba(255,255,255,0.25)"
          thumbTintColor={primary}
        />
      </View>
    ))}
  </ScrollView>
);

const FilterControls = ({
  selected,
  onSelect,
  primary,
}: {
  selected: string;
  onSelect: (id: string) => void;
  primary: string;
}) => (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
    {FILTER_PRESETS.map((preset) => (
      <Pressable
        key={preset.id}
        onPress={() => onSelect(preset.id)}
        style={[styles.filterChip, selected === preset.id && { backgroundColor: primary }]}
      >
        <Text style={styles.chipText}>{preset.label}</Text>
      </Pressable>
    ))}
  </ScrollView>
);

const DrawControls = ({
  penColor,
  onPenColor,
  penWidth,
  onPenWidth,
  canUndo,
  onUndo,
  primary,
}: {
  penColor: string;
  onPenColor: (color: string) => void;
  penWidth: number;
  onPenWidth: (value: number) => void;
  canUndo: boolean;
  onUndo: () => void;
  primary: string;
}) => (
  <View style={styles.panel}>
    <View style={styles.rowBetween}>
      <View style={styles.colorRow}>
        {PEN_COLORS.map((color) => (
          <Pressable
            key={color}
            onPress={() => onPenColor(color)}
            accessibilityLabel={`Pen colour ${color}`}
            style={[
              styles.swatch,
              { backgroundColor: color },
              penColor === color && styles.swatchSelected,
            ]}
          />
        ))}
      </View>
      <Pressable
        onPress={onUndo}
        disabled={!canUndo}
        style={[styles.iconAction, !canUndo && styles.disabled]}
        accessibilityLabel="Undo last stroke"
      >
        <Ionicons name="arrow-undo-outline" size={20} color="#fff" />
        <Text style={styles.iconActionText}>Undo</Text>
      </Pressable>
    </View>
    <View style={styles.sliderRow}>
      <Text style={styles.sliderLabel}>Brush size</Text>
      <Slider
        style={styles.slider}
        minimumValue={0.004}
        maximumValue={0.05}
        value={penWidth}
        onValueChange={onPenWidth}
        minimumTrackTintColor={primary}
        maximumTrackTintColor="rgba(255,255,255,0.25)"
        thumbTintColor={primary}
      />
    </View>
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerButton: { minWidth: 64, alignItems: 'center' },
  headerButtonText: { color: '#fff', fontSize: 16 },
  headerResetText: { color: 'rgba(255,255,255,0.65)', fontSize: 15 },
  headerDone: { fontWeight: '700' },
  stage: { width: '100%', justifyContent: 'center', alignItems: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { color: 'rgba(255,255,255,0.75)', fontSize: 14, paddingHorizontal: 32, textAlign: 'center' },
  controls: { paddingHorizontal: 12, gap: 10 },
  controlCard: { minHeight: 118 },
  controlCardContent: { padding: 12 },
  panel: { gap: 10, maxHeight: 150 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  straightenWrap: { flex: 1 },
  iconAction: { alignItems: 'center', gap: 2, minWidth: 54 },
  iconActionText: { color: '#fff', fontSize: 11 },
  disabled: { opacity: 0.35 },
  chipRow: { gap: 8, paddingVertical: 4, alignItems: 'center' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sliderRow: { gap: 2 },
  sliderLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600' },
  slider: { width: '100%', height: 32 },
  colorRow: { flexDirection: 'row', gap: 8, flexShrink: 1 },
  swatch: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  swatchSelected: { borderColor: '#fff', borderWidth: 3 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 4 },
  toolButton: { alignItems: 'center', gap: 3, paddingHorizontal: 12, paddingVertical: 6 },
  toolLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
});
