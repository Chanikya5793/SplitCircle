// Small, pure stat visuals for the stats screens (ai_layer/docs/22).
// All of these are display-only: geometry from numbers, money text arrives
// PRE-FORMATTED through the guard/lens funnels (useMoneyDisplay) — nothing
// here formats currency. Colors come exclusively from theme tokens; series
// identity always ships with a direct label (dot + name), never color alone.

import { useTheme } from '@/context/ThemeContext';
import type { HeatmapData } from '@/utils/statsInsights';
import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Text } from 'react-native-paper';

// ── Building block: one thin horizontal bar ──────────────────────────────────

interface HBarProps {
  value: number;
  max: number;
  color: string;
  height?: number;
  trackColor?: string;
}

/** Thin rounded bar, baseline-anchored. `max<=0` renders an empty track. */
export const HBar = ({ value, max, color, height = 6, trackColor }: HBarProps) => {
  const { theme } = useTheme();
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <View
      style={[
        styles.hbarTrack,
        { height, borderRadius: height / 2, backgroundColor: trackColor ?? theme.colors.pressed },
      ]}
    >
      <View
        style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: color }}
      />
    </View>
  );
};

// ── Category share bar (stacked segments + labeled legend) ───────────────────

export interface ShareSlice {
  label: string;
  value: number;
}

interface CategoryShareBarProps {
  /** Descending slices; anything past the 5th folds into "Other". */
  slices: ShareSlice[];
}

export const CategoryShareBar = ({ slices }: CategoryShareBarProps) => {
  const { theme } = useTheme();
  const shown = slices.slice(0, 5);
  const rest = slices.slice(5).reduce((s, c) => s + c.value, 0);
  const parts = rest > 0 ? [...shown, { label: 'Other', value: rest }] : shown;
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return null;
  // Fixed hue order from the theme's categorical ramp; "Other" always takes the
  // muted final slot regardless of how many named slices precede it.
  const colorFor = (i: number, label: string) =>
    label === 'Other' ? theme.colors.chart[7] : theme.colors.chart[i % theme.colors.chart.length];
  return (
    <View style={styles.shareWrap}>
      <View style={styles.shareBar}>
        {parts.map((p, i) => (
          <View
            key={p.label}
            style={{
              flex: Math.max(p.value / total, 0.02),
              backgroundColor: colorFor(i, p.label),
              borderRadius: 3,
            }}
          />
        ))}
      </View>
      <View style={styles.shareLegend}>
        {parts.map((p, i) => (
          <View key={p.label} style={styles.legendChip}>
            <View style={[styles.legendDot, { backgroundColor: colorFor(i, p.label) }]} />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
              {p.label} {Math.round((p.value / total) * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
};

// ── Momentum: paired prev/current bars per category ──────────────────────────

export interface MomentumRow {
  label: string;
  current: number;
  previous: number;
  /** Signed percent, null for brand-new categories. */
  deltaPct: number | null;
  /** Pre-formatted current amount (guard/lens funnel output). */
  amountLabel: string;
}

export const MomentumBars = ({ rows }: { rows: MomentumRow[] }) => {
  const { theme } = useTheme();
  const max = rows.reduce((m, r) => Math.max(m, r.current, r.previous), 0);
  if (max <= 0) return null;
  return (
    <View style={styles.momentumStack}>
      {rows.map((r) => {
        const up = (r.deltaPct ?? 0) > 0;
        const deltaColor =
          r.deltaPct == null
            ? theme.colors.onSurfaceVariant
            : up
              ? theme.colors.warning
              : theme.colors.success;
        return (
          <View key={r.label} style={styles.momentumRow}>
            <View style={styles.momentumHeader}>
              <Text
                variant="labelMedium"
                style={[styles.momentumLabel, { color: theme.colors.onSurface }]}
                numberOfLines={1}
              >
                {r.label}
              </Text>
              <Text variant="labelSmall" style={{ color: deltaColor, fontWeight: '700' }}>
                {r.deltaPct == null ? 'new' : `${up ? '+' : ''}${r.deltaPct}%`}
              </Text>
              <Text
                variant="labelSmall"
                style={{ color: theme.colors.onSurfaceVariant, fontVariant: ['tabular-nums'] }}
              >
                {r.amountLabel}
              </Text>
            </View>
            <HBar value={r.previous} max={max} color={theme.colors.chart[7]} height={4} />
            <HBar value={r.current} max={max} color={theme.colors.chart[0]} height={6} />
          </View>
        );
      })}
      <View style={styles.shareLegend}>
        <View style={styles.legendChip}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.chart[0] }]} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            This month
          </Text>
        </View>
        <View style={styles.legendChip}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.chart[7] }]} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Last month
          </Text>
        </View>
      </View>
    </View>
  );
};

// ── Spending rhythm heatmap (weekday × week) ─────────────────────────────────

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
// Sequential encoding: one hue (accent), stepped alpha. Hex-suffix alpha is the
// established theme idiom (`${primary}1f`).
const HEAT_ALPHAS = ['47', '75', 'a8', 'ff'];

export const SpendHeatmap = ({ data }: { data: HeatmapData }) => {
  const { theme } = useTheme();
  const [width, setWidth] = useState(0);
  const weeks = data.grid.length;
  if (weeks === 0 || data.max <= 0) return null;

  const labelW = 14;
  const gap = 3;
  const cell = width > 0 ? Math.min(18, Math.floor((width - labelW - gap * weeks) / weeks)) : 0;

  const cellColor = (w: number, d: number): string => {
    const afterToday = w > data.todayWeek || (w === data.todayWeek && d > data.todayDay);
    if (afterToday) return 'transparent';
    const v = data.grid[w][d];
    if (v <= 0) return theme.colors.pressed;
    const bucket = Math.min(HEAT_ALPHAS.length - 1, Math.floor((v / data.max) * HEAT_ALPHAS.length));
    return `${theme.colors.chart[0]}${HEAT_ALPHAS[bucket]}`;
  };

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View onLayout={onLayout}>
      {cell > 0 && (
        <View style={{ gap }}>
          {DAY_INITIALS.map((initial, d) => (
            <View key={`${initial}-${d}`} style={[styles.heatRow, { gap }]}>
              <Text
                variant="labelSmall"
                style={[styles.heatDayLabel, { color: theme.colors.onSurfaceVariant, width: labelW, fontSize: 9 }]}
              >
                {d % 2 === 1 ? initial : ''}
              </Text>
              {data.grid.map((_, w) => (
                <View
                  key={w}
                  style={{ width: cell, height: cell, borderRadius: 4, backgroundColor: cellColor(w, d) }}
                />
              ))}
            </View>
          ))}
          {/* Labeled columns are ≥3 apart (helper guarantees it), so a 3-cell-wide
              absolutely-positioned label never collides with the next one. */}
          <View style={styles.heatMonthRow}>
            {data.monthLabels.map((label, w) =>
              label ? (
                <Text
                  key={w}
                  variant="labelSmall"
                  numberOfLines={1}
                  style={{
                    position: 'absolute',
                    left: labelW + gap + w * (cell + gap),
                    width: cell * 3 + gap * 2,
                    color: theme.colors.onSurfaceVariant,
                    fontSize: 9,
                  }}
                >
                  {label}
                </Text>
              ) : null,
            )}
          </View>
        </View>
      )}
    </View>
  );
};

// ── Pace bullet: month-to-date vs projection vs last month ───────────────────

interface PaceBulletProps {
  monthToDate: number;
  projectedTotal: number;
  previousMonthTotal: number;
}

export const PaceBullet = ({ monthToDate, projectedTotal, previousMonthTotal }: PaceBulletProps) => {
  const { theme } = useTheme();
  const scaleMax = Math.max(monthToDate, projectedTotal, previousMonthTotal) * 1.05;
  if (scaleMax <= 0) return null;
  const pct = (v: number) => Math.min(100, (v / scaleMax) * 100);
  return (
    <View style={styles.paceWrap}>
      <View style={[styles.paceTrack, { backgroundColor: theme.colors.pressed }]}>
        <View
          style={[
            styles.paceFill,
            { width: `${pct(projectedTotal)}%`, backgroundColor: `${theme.colors.chart[0]}40` },
          ]}
        />
        <View
          style={[
            styles.paceFill,
            { width: `${pct(monthToDate)}%`, backgroundColor: theme.colors.chart[0] },
          ]}
        />
        {previousMonthTotal > 0 && (
          <View
            style={[
              styles.paceMarker,
              { left: `${pct(previousMonthTotal)}%`, backgroundColor: theme.colors.onSurface },
            ]}
          />
        )}
      </View>
      <View style={styles.shareLegend}>
        <View style={styles.legendChip}>
          <View style={[styles.legendDot, { backgroundColor: theme.colors.chart[0] }]} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            So far
          </Text>
        </View>
        <View style={styles.legendChip}>
          <View style={[styles.legendDot, { backgroundColor: `${theme.colors.chart[0]}40` }]} />
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Projected
          </Text>
        </View>
        {previousMonthTotal > 0 && (
          <View style={styles.legendChip}>
            <View style={[styles.legendTick, { backgroundColor: theme.colors.onSurface }]} />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Last month
            </Text>
          </View>
        )}
      </View>
    </View>
  );
};

// ── Fairness ring: share of spend fronted by the top payer ───────────────────

export const FairnessRing = ({ pct, size = 52 }: { pct: number; size?: number }) => {
  const { theme } = useTheme();
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={theme.colors.pressed}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={theme.colors.chart[0]}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c}`}
          strokeDashoffset={c * (1 - clamped / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text
        variant="labelSmall"
        style={{ color: theme.colors.onSurface, fontWeight: '700', fontVariant: ['tabular-nums'] }}
      >
        {Math.round(clamped)}%
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  hbarTrack: {
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  shareWrap: {
    gap: 8,
  },
  shareBar: {
    flexDirection: 'row',
    height: 10,
    gap: 2,
  },
  shareLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 4,
  },
  legendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '48%',
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendTick: {
    width: 2,
    height: 10,
    borderRadius: 1,
  },
  momentumStack: {
    gap: 12,
  },
  momentumRow: {
    gap: 3,
  },
  momentumHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 1,
  },
  momentumLabel: {
    flex: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  heatRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  heatDayLabel: {
    textAlign: 'center',
  },
  heatMonthRow: {
    height: 14,
  },
  paceWrap: {
    gap: 8,
    marginTop: 10,
  },
  paceTrack: {
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
  },
  paceFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 6,
  },
  paceMarker: {
    position: 'absolute',
    top: -1,
    bottom: -1,
    width: 2,
    borderRadius: 1,
  },
});
