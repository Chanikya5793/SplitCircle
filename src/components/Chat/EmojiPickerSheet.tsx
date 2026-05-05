import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import { BlurView } from 'expo-blur';
import React, { memo, useMemo, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import Animated, { SlideInDown } from 'react-native-reanimated';

type Category =
  | 'Smileys'
  | 'Hands'
  | 'Hearts'
  | 'Animals'
  | 'Food'
  | 'Activities'
  | 'Objects'
  | 'Symbols';

const CATEGORIES: Record<Category, { icon: string; emojis: string[] }> = {
  Smileys: {
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
      '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
      '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
      '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
      '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐',
      '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦',
      '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
      '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿',
      '💀', '☠️', '💩', '🤡', '👻', '👽', '👾', '🤖',
    ],
  },
  Hands: {
    icon: '👍',
    emojis: [
      '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉',
      '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤝', '🙌',
      '👏', '🙏', '✍️', '💪', '🦾', '🦵', '🦶', '👂', '👃', '🧠',
      '👁️', '👀', '👅', '👄', '💋',
    ],
  },
  Hearts: {
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️',
    ],
  },
  Animals: {
    icon: '🐶',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒',
      '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗',
      '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦂', '🐢',
      '🐍', '🦎', '🦕', '🦖', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡',
      '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓',
      '🦍', '🐘', '🦏', '🐫', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖',
      '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🐈', '🐓', '🦃',
      '🦚', '🦜', '🦢', '🐇', '🐀', '🐿️', '🦔', '🌵', '🎄', '🌲',
      '🌳', '🌴', '🌱', '🌿', '☘️', '🍀', '🎍', '🎋', '🍃', '🍂',
      '🍁', '🍄', '🌾', '💐', '🌷', '🌹', '🥀', '🌺', '🌸', '🌼',
      '🌻',
    ],
  },
  Food: {
    icon: '🍔',
    emojis: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐',
      '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑',
      '🥦', '🥬', '🥒', '🌶️', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔',
      '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈',
      '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟',
      '🍕', '🥪', '🥙', '🧆', '🌮', '🌯', '🥗', '🥘', '🍝', '🍜',
      '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘',
      '🍥', '🥠', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰',
      '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜',
      '🍯', '🥛', '🍼', '☕', '🫖', '🍵', '🧃', '🥤', '🍶', '🍺',
      '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾',
    ],
  },
  Activities: {
    icon: '⚽',
    emojis: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱',
      '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🥅', '⛳', '🪁',
      '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛷', '⛸️', '🥌',
      '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '🤺', '🤾',
      '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴',
      '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️',
      '🎪', '🤹', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹',
      '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳',
      '🎮', '🎰', '🧩',
    ],
  },
  Objects: {
    icon: '💡',
    emojis: [
      '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️',
      '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥',
      '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️',
      '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋',
      '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴',
      '💶', '💷', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🔧', '🔨',
      '⚒️', '🛠️', '⛏️', '🪛', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲',
      '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️',
      '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈', '⚗️', '🔭', '🔬',
      '🕳️', '💊', '💉', '🩸', '🩹', '🩺', '🌡️', '🧬', '🦠', '🧫',
      '🧪', '🧴', '🧷', '🧸', '🧵', '🪡', '🧶', '🪢', '👓', '🕶️',
      '🥽', '🥼', '🦺', '👔', '👕', '👖', '🧣', '🧤', '🧥', '🧦',
      '👗', '👘', '🥻', '🩴', '🩱', '🩲', '🩳', '👙', '👚', '👛',
      '👜', '👝', '🛍️', '🎒', '🩰', '👞', '👟', '🥾', '🥿', '👠',
      '👡', '👢', '👑', '👒', '🎩', '🎓', '🧢', '⛑️', '📿', '💄',
      '💍', '💼',
    ],
  },
  Symbols: {
    icon: '✨',
    emojis: [
      '✨', '⭐', '🌟', '💫', '⚡', '🔥', '💥', '☄️', '🌈', '☀️',
      '🌤️', '⛅', '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️', '🌨️', '❄️',
      '☃️', '⛄', '🌬️', '💨', '💧', '💦', '☔', '🌊', '🎉', '🎊',
      '🎈', '🎂', '🎁', '🎀', '🪄', '✅', '❌', '⭕', '🛑', '⛔',
      '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞',
      '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆',
      '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✳️', '❇️', '☑️',
      '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️',
      '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏',
      '♐', '♑', '♒', '♓',
    ],
  },
};

const CATEGORY_ORDER: Category[] = [
  'Smileys',
  'Hands',
  'Hearts',
  'Animals',
  'Food',
  'Activities',
  'Objects',
  'Symbols',
];

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMNS = 8;
const EMOJI_SIZE = Math.floor((SCREEN_WIDTH - 32) / COLUMNS);

interface EmojiPickerSheetProps {
  visible: boolean;
  /** Emojis the current user has already reacted with — highlighted in the grid. */
  selectedEmojis?: string[];
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export const EmojiPickerSheet = memo(({
  visible,
  selectedEmojis,
  onPick,
  onClose,
}: EmojiPickerSheetProps) => {
  const { theme, isDark } = useTheme();
  const [activeCategory, setActiveCategory] = useState<Category>('Smileys');

  const selectedSet = useMemo(() => new Set(selectedEmojis ?? []), [selectedEmojis]);

  const handlePick = (emoji: string) => {
    lightHaptic();
    onPick(emoji);
    onClose();
  };

  const surface = (theme.colors as any).elevation?.level3 ?? theme.colors.surface;
  const tabActive = theme.colors.surfaceVariant ?? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)');
  const selectedBg = `${theme.colors.primary}26`; // ~15% primary

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <BlurView
          intensity={15}
          tint={isDark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
      </Pressable>
      <Animated.View style={styles.sheetAnchor} entering={SlideInDown.duration(260)}>
        <View style={[styles.sheet, { backgroundColor: surface }]}>
          <View style={styles.sheetHandle} />
          <Text
            variant="titleSmall"
            style={[styles.sheetTitle, { color: theme.colors.onSurface }]}
          >
            Pick a reaction
          </Text>

          {/* Category tab strip */}
          <View style={styles.tabStrip}>
            {CATEGORY_ORDER.map((cat) => {
              const active = cat === activeCategory;
              return (
                <TouchableOpacity
                  key={cat}
                  onPress={() => setActiveCategory(cat)}
                  style={[
                    styles.tabButton,
                    active && { backgroundColor: tabActive },
                  ]}
                  activeOpacity={0.7}
                  accessibilityRole="tab"
                  accessibilityLabel={cat}
                  accessibilityState={{ selected: active }}
                >
                  <Text style={styles.tabIcon}>{CATEGORIES[cat].icon}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Emoji grid */}
          <ScrollView
            style={styles.gridScroll}
            contentContainerStyle={styles.gridContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.grid}>
              {CATEGORIES[activeCategory].emojis.map((emoji) => {
                const selected = selectedSet.has(emoji);
                return (
                  <TouchableOpacity
                    key={emoji}
                    onPress={() => handlePick(emoji)}
                    style={[
                      styles.emojiCell,
                      { width: EMOJI_SIZE, height: EMOJI_SIZE },
                      selected && {
                        backgroundColor: selectedBg,
                        borderWidth: 1.5,
                        borderColor: theme.colors.primary,
                        borderRadius: EMOJI_SIZE / 2,
                      },
                    ]}
                    activeOpacity={0.6}
                    accessibilityRole="button"
                    accessibilityLabel={selected ? `Remove ${emoji} reaction` : `React with ${emoji}`}
                  >
                    <Text style={styles.emoji}>{emoji}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </View>
      </Animated.View>
    </Modal>
  );
});

EmojiPickerSheet.displayName = 'EmojiPickerSheet';

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  sheetAnchor: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingBottom: 40,
    paddingTop: 12,
    height: 460,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 20,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.3)',
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetTitle: {
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 16,
  },
  tabStrip: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    marginBottom: 8,
    justifyContent: 'space-between',
  },
  tabButton: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  tabIcon: {
    fontSize: 20,
  },
  gridScroll: {
    flex: 1,
  },
  gridContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emojiCell: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 28,
  },
});

export default EmojiPickerSheet;
