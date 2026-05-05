import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { getContentUriAsync, getInfoAsync, readAsStringAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import Pdf from 'react-native-pdf';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface FilePreviewParams {
  uri: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'unsupported';

const detectKind = (mimeType?: string, fileName?: string): PreviewKind => {
  const mt = (mimeType ?? '').toLowerCase();
  const fn = (fileName ?? '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt === 'application/pdf' || fn.endsWith('.pdf')) return 'pdf';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (
    mt.startsWith('text/') ||
    mt.includes('json') ||
    mt.includes('xml') ||
    /\.(txt|md|csv|log|json|xml|html|js|ts|tsx|jsx|py|java|c|cpp|h|css|yml|yaml)$/.test(fn)
  ) {
    return 'text';
  }
  return 'unsupported';
};

export const FilePreviewScreen = () => {
  const navigation = useNavigation();
  const route = useRoute();
  const params = route.params as FilePreviewParams;
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();

  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfPageInfo, setPdfPageInfo] = useState<{ current: number; total: number } | null>(null);

  const kind = detectKind(params.mimeType, params.fileName);

  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  useEffect(() => {
    if (kind !== 'text') return;
    let cancelled = false;
    setTextLoading(true);
    setTextError(null);
    (async () => {
      try {
        const info = await getInfoAsync(params.uri);
        if (!info.exists) {
          if (!cancelled) setTextError('File not found on device.');
          return;
        }
        // Cap text preview at ~512KB to keep the renderer responsive on
        // unbounded log files.
        const content = await readAsStringAsync(params.uri);
        if (cancelled) return;
        setTextContent(content.length > 512_000 ? content.slice(0, 512_000) + '\n\n…(truncated)' : content);
      } catch (e) {
        if (!cancelled) setTextError(e instanceof Error ? e.message : 'Failed to read file');
      } finally {
        if (!cancelled) setTextLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, params.uri]);

  const handleOpenExternally = async () => {
    lightHaptic();
    const mimeType = params.mimeType || 'application/octet-stream';
    const fileName = params.fileName || 'Document';
    try {
      const fileInfo = await getInfoAsync(params.uri);
      if (!fileInfo.exists) {
        Alert.alert('File Not Found', 'The file could not be found on this device.');
        return;
      }
      const isAvailable = await Sharing.isAvailableAsync();
      if (isAvailable) {
        await Sharing.shareAsync(params.uri, {
          mimeType,
          dialogTitle: `Open ${fileName}`,
          UTI: mimeType,
        });
      } else if (Platform.OS === 'android') {
        const contentUri = await getContentUriAsync(params.uri);
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          type: mimeType,
          flags: 1,
        });
      } else {
        const canOpen = await Linking.canOpenURL(params.uri);
        if (canOpen) await Linking.openURL(params.uri);
      }
    } catch (e) {
      Alert.alert('Cannot Open', `Unable to open ${fileName}.`);
    }
  };

  const renderHeader = () => (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 8,
          backgroundColor: isDark
            ? `${theme.colors.surface}E6`
            : `${theme.colors.surface}D9`,
        },
      ]}
    >
      <TouchableOpacity
        onPress={() => navigation.goBack()}
        hitSlop={10}
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="chevron-back" size={26} color={theme.colors.onSurface} />
      </TouchableOpacity>
      <View style={styles.headerCenter}>
        <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.onSurface }]}>
          {params.fileName || 'File'}
        </Text>
        {kind === 'pdf' && pdfPageInfo ? (
          <Text style={[styles.headerSub, { color: theme.colors.onSurfaceVariant }]}>
            Page {pdfPageInfo.current} of {pdfPageInfo.total}
            {params.fileSize ? ` · ${formatFileSize(params.fileSize)}` : ''}
          </Text>
        ) : (
          !!params.fileSize && (
            <Text style={[styles.headerSub, { color: theme.colors.onSurfaceVariant }]}>
              {formatFileSize(params.fileSize)}
            </Text>
          )
        )}
      </View>
      <TouchableOpacity
        onPress={handleOpenExternally}
        hitSlop={10}
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel="Open with another app"
      >
        <Ionicons name="share-outline" size={22} color={theme.colors.onSurface} />
      </TouchableOpacity>
    </View>
  );

  const renderContent = () => {
    if (kind === 'image') {
      return (
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          contentContainerStyle={styles.imageWrap}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image
            source={{ uri: params.uri }}
            style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT * 0.8 }}
            resizeMode="contain"
          />
        </ScrollView>
      );
    }

    if (kind === 'pdf') {
      if (pdfError) {
        return (
          <View style={styles.center}>
            <Ionicons name="alert-circle" size={48} color={theme.colors.error} />
            <Text style={[styles.unsupportedTitle, { color: theme.colors.onSurface }]}>
              Could not display PDF
            </Text>
            <Text style={[styles.unsupportedSub, { color: theme.colors.onSurfaceVariant }]}>
              {pdfError}
            </Text>
            <TouchableOpacity
              onPress={handleOpenExternally}
              style={[styles.openButton, { backgroundColor: theme.colors.primary }]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Open with another app"
            >
              <Ionicons name="open-outline" size={18} color={theme.colors.onPrimary} />
              <Text style={[styles.openButtonText, { color: theme.colors.onPrimary }]}>
                Open with another app
              </Text>
            </TouchableOpacity>
          </View>
        );
      }

      const pdfSource = Platform.OS === 'android' && !params.uri.startsWith('content://') && !params.uri.startsWith('file://')
        ? { uri: `file://${params.uri}`, cache: true }
        : { uri: params.uri, cache: true };

      return (
        <View style={[styles.pdfContainer, { backgroundColor: theme.colors.background }]}>
          <Pdf
            source={pdfSource}
            trustAllCerts={false}
            style={styles.pdf}
            onLoadComplete={(numberOfPages) => {
              setPdfLoading(false);
              setPdfPageInfo({ current: 1, total: numberOfPages });
            }}
            onPageChanged={(page, numberOfPages) => {
              setPdfPageInfo({ current: page, total: numberOfPages });
            }}
            onError={(err) => {
              setPdfLoading(false);
              setPdfError(err instanceof Error ? err.message : 'Failed to render PDF');
            }}
            enablePaging
            renderActivityIndicator={() => (
              <ActivityIndicator color={theme.colors.primary} size="large" />
            )}
          />
          {pdfLoading && (
            <View style={styles.pdfLoadingOverlay} pointerEvents="none">
              <ActivityIndicator color={theme.colors.primary} size="large" />
              <Text style={[styles.pdfLoadingText, { color: theme.colors.onSurfaceVariant }]}>
                Loading PDF…
              </Text>
            </View>
          )}
        </View>
      );
    }

    if (kind === 'text') {
      if (textLoading) {
        return (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        );
      }
      if (textError) {
        return (
          <View style={styles.center}>
            <Ionicons name="alert-circle" size={36} color={theme.colors.error} />
            <Text style={[styles.errorText, { color: theme.colors.onSurface }]}>{textError}</Text>
            <TouchableOpacity
              onPress={handleOpenExternally}
              style={[styles.openButton, { backgroundColor: theme.colors.primary }]}
              activeOpacity={0.85}
            >
              <Ionicons name="open-outline" size={18} color={theme.colors.onPrimary} />
              <Text style={[styles.openButtonText, { color: theme.colors.onPrimary }]}>Open with another app</Text>
            </TouchableOpacity>
          </View>
        );
      }
      return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.textContent}>
          <Text
            selectable
            style={[styles.textBody, { color: theme.colors.onSurface }]}
          >
            {textContent ?? ''}
          </Text>
        </ScrollView>
      );
    }

    // video / audio / unsupported — defer to the system. No native viewer
    // bundled for these types; we open the share sheet so the user has a
    // route forward instead of getting stuck on a blank screen.
    return (
      <View style={styles.center}>
        <Ionicons
          name={
            kind === 'video'
              ? 'videocam-outline'
              : kind === 'audio'
                ? 'musical-notes-outline'
                : 'document-outline'
          }
          size={64}
          color={theme.colors.primary}
        />
        <Text style={[styles.unsupportedTitle, { color: theme.colors.onSurface }]}>
          {kind === 'unsupported' ? 'Preview not available' : 'Open with system player'}
        </Text>
        <Text style={[styles.unsupportedSub, { color: theme.colors.onSurfaceVariant }]}>
          This file type opens best in another app on your device.
        </Text>
        <TouchableOpacity
          onPress={handleOpenExternally}
          style={[styles.openButton, { backgroundColor: theme.colors.primary }]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Open with another app"
        >
          <Ionicons name="open-outline" size={18} color={theme.colors.onPrimary} />
          <Text style={[styles.openButtonText, { color: theme.colors.onPrimary }]}>Open</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <LiquidBackground>
      <View style={styles.root}>
        {renderHeader()}
        <View style={{ flex: 1 }}>{renderContent()}</View>
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 6,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, paddingHorizontal: 4 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 1 },
  imageWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  pdfContainer: { flex: 1 },
  pdf: { flex: 1, width: SCREEN_WIDTH },
  pdfLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  pdfLoadingText: { fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  errorText: { fontSize: 14, textAlign: 'center' },
  textContent: { padding: 16 },
  textBody: { fontSize: 13, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  unsupportedTitle: { fontSize: 18, fontWeight: '700' },
  unsupportedSub: { fontSize: 13, textAlign: 'center', maxWidth: 280 },
  openButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 24,
    gap: 8,
    marginTop: 6,
  },
  openButtonText: { fontSize: 15, fontWeight: '600' },
});

export default FilePreviewScreen;
