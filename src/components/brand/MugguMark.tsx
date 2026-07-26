import { brand } from '@/theme/brand';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import {
  MUGGU_DOTS,
  MUGGU_FULL_DASH,
  MUGGU_PETAL_PATH,
  MUGGU_SIMPLIFIED_DASH,
} from './mugguGeometry';

export type MugguVariant =
  | 'primary'
  | 'symmetric'
  | 'reversed'
  | 'appIcon'
  | 'monoInk'
  | 'monoWhite';

interface MugguColors {
  petals: readonly [string, string, string, string];
  center: string;
  dots: string;
}

export const getMugguColors = (variant: MugguVariant): MugguColors => {
  switch (variant) {
    case 'symmetric':
      return {
        petals: [brand.ink, brand.ink, brand.ink, brand.ink],
        center: brand.gold,
        dots: brand.gold,
      };
    case 'reversed':
      return {
        petals: [brand.reversedGold, brand.reversedInk, brand.reversedInk, brand.reversedInk],
        center: brand.reversedInk,
        dots: brand.reversedGold,
      };
    case 'appIcon':
      return {
        petals: [brand.reversedInk, brand.reversedInk, brand.reversedInk, brand.reversedInk],
        center: brand.reversedGold,
        dots: brand.reversedGold,
      };
    case 'monoInk':
      return {
        petals: [brand.ink, brand.ink, brand.ink, brand.ink],
        center: brand.ink,
        dots: brand.ink,
      };
    case 'monoWhite':
      return {
        petals: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
        center: '#FFFFFF',
        dots: '#FFFFFF',
      };
    case 'primary':
    default:
      return {
        petals: [brand.gold, brand.ink, brand.ink, brand.ink],
        center: brand.ink,
        dots: brand.gold,
      };
  }
};

interface MugguMarkProps {
  size?: number;
  variant?: MugguVariant;
  simplified?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

export const MugguMark = ({
  size = 96,
  variant = 'primary',
  simplified = size < 28,
  style,
  accessibilityLabel,
  testID,
}: MugguMarkProps) => {
  const colors = getMugguColors(variant);
  const strokeWidth = simplified ? 9 : 7.2;
  const dashArray = simplified ? MUGGU_SIMPLIFIED_DASH : MUGGU_FULL_DASH;

  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible={Boolean(accessibilityLabel)}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 120 120"
        fill="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {colors.petals.map((color, index) => (
          <Path
            key={`petal-${index}`}
            d={MUGGU_PETAL_PATH}
            transform={`rotate(${index * 90} 60 60)`}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={dashArray}
          />
        ))}
        <Circle cx={60} cy={60} r={simplified ? 7 : 8.5} fill={colors.center} />
        {!simplified &&
          MUGGU_DOTS.map((dot, index) => (
            <Circle
              key={`dot-${index}`}
              cx={dot.cx}
              cy={dot.cy}
              r={4.2}
              fill={colors.dots}
            />
          ))}
      </Svg>
    </View>
  );
};
