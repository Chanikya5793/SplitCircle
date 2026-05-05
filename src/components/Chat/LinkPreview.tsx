import { useTheme } from '@/context/ThemeContext';
import type { UrlPreview } from '@/models';
import { getDomain } from '@/services/linkPreviewService';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image, Linking, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

interface LinkPreviewProps {
  preview: UrlPreview;
  isMine: boolean;
}

export const LinkPreview = ({ preview, isMine }: LinkPreviewProps) => {
  const { theme, isDark } = useTheme();

  const handlePress = () => {
    Linking.openURL(preview.url).catch((err) =>
      console.warn('Failed to open URL', err),
    );
  };

  const surface = isMine
    ? 'rgba(0,0,0,0.18)'
    : isDark
      ? 'rgba(255,255,255,0.08)'
      : 'rgba(0,0,0,0.04)';
  const accent = isMine ? 'rgba(255,255,255,0.8)' : theme.colors.primary;
  const titleColor = isMine ? '#fff' : theme.colors.onSurface;
  const subColor = isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant;

  // Failed / minimal preview — render a compact link card so the user still
  // sees something tappable below their message instead of a dead URL.
  if (preview.failed || (!preview.title && !preview.description && !preview.imageUrl)) {
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePress}
        style={[styles.compactCard, { backgroundColor: surface, borderLeftColor: accent }]}
      >
        <Ionicons name="link" size={16} color={accent} />
        <Text style={[styles.compactDomain, { color: titleColor }]} numberOfLines={1}>
          {getDomain(preview.url)}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={handlePress}
      style={[styles.card, { backgroundColor: surface, borderLeftColor: accent }]}
    >
      {preview.imageUrl ? (
        <Image
          source={{ uri: preview.imageUrl }}
          style={styles.image}
          resizeMode="cover"
        />
      ) : null}
      <View style={styles.body}>
        {preview.siteName ? (
          <Text style={[styles.site, { color: subColor }]} numberOfLines={1}>
            {preview.siteName}
          </Text>
        ) : (
          <Text style={[styles.site, { color: subColor }]} numberOfLines={1}>
            {getDomain(preview.url)}
          </Text>
        )}
        {preview.title ? (
          <Text style={[styles.title, { color: titleColor }]} numberOfLines={2}>
            {preview.title}
          </Text>
        ) : null}
        {preview.description ? (
          <Text style={[styles.description, { color: subColor }]} numberOfLines={2}>
            {preview.description}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    overflow: 'hidden',
    borderLeftWidth: 3,
    marginTop: 2,
    marginBottom: 4,
  },
  image: {
    width: '100%',
    height: 150,
  },
  body: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  site: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
  },
  compactCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderLeftWidth: 3,
    marginTop: 2,
    marginBottom: 4,
  },
  compactDomain: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
  },
});

export default LinkPreview;
