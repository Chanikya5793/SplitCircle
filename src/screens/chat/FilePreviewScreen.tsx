import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { getContentUriAsync, getInfoAsync, readAsStringAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface FilePreviewParams {
  uri: string;
  /**
   * Optional public/Firebase URL. Used as the source for the in-app browser
   * preview (PDFs render natively in SFSafariViewController / Chrome Custom
   * Tabs; office docs route through the Google Docs viewer).
   */
  remoteUri?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'unsupported';

const HTTP_URL = /^https?:\/\//i;
const OFFICE_DOC_PATTERN = /\.(docx?|xlsx?|pptx?)$/i;
const OFFICE_MIME_PATTERN = /(msword|wordprocessingml|spreadsheetml|presentationml|ms-excel|ms-powerpoint)/i;

const isOfficeDoc = (mimeType?: string, fileName?: string): boolean => {
  if (mimeType && OFFICE_MIME_PATTERN.test(mimeType)) return true;
  if (fileName && OFFICE_DOC_PATTERN.test(fileName)) return true;
  return false;
};

const buildBrowserPreviewUrl = (
  remoteUri: string,
  kind: PreviewKind,
  mimeType?: string,
  fileName?: string,
): string | null => {
  if (!HTTP_URL.test(remoteUri)) return null;
  // PDFs render natively in the system in-app browser on both platforms.
  if (kind === 'pdf') return remoteUri;
  // Office docs need an external renderer — the Google Docs viewer handles
  // .doc/.docx/.xls/.xlsx/.ppt/.pptx without us shipping a native viewer.
  if (isOfficeDoc(mimeType, fileName)) {
    return `https://docs.google.com/viewer?url=${encodeURIComponent(remoteUri)}&embedded=true`;
  }
  return null;
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

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
  const [browserOpening, setBrowserOpening] = useState(false);

  const kind = detectKind(params.mimeType, params.fileName);
  const browserPreviewUrl = params.remoteUri
    ? buildBrowserPreviewUrl(params.remoteUri, kind, params.mimeType, params.fileName)
    : null;
  const hasInAppBrowserPreview = !!browserPreviewUrl;

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

  const handleOpenInBrowser = useCallback(async () => {
    if (!browserPreviewUrl) return;
    lightHaptic();
    setBrowserOpening(true);
    try {
      await WebBrowser.openBrowserAsync(browserPreviewUrl, {
        // Match the chat surface so the transition doesn't flash white.
        toolbarColor: theme.colors.surface,
        controlsColor: theme.colors.primary,
        dismissButtonStyle: 'close',
        showTitle: true,
        enableBarCollapsing: true,
      });
    } catch (e) {
      Alert.alert('Cannot Open', 'Unable to open the in-app preview.');
    } finally {
      setBrowserOpening(false);
    }
  }, [browserPreviewUrl, theme.colors.primary, theme.colors.surface]);

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
        {!!params.fileSize && (
          <Text style={[styles.headerSub, { color: theme.colors.onSurfaceVariant }]}>
            {formatFileSize(params.fileSize)}
          </Text>
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
      return (
        <View style={styles.center}>
          <Ionicons name="document-text-outline" size={64} color={theme.colors.primary} />
          <Text style={[styles.unsupportedTitle, { color: theme.colors.onSurface }]}>
            PDF Document
          </Text>
          <Text style={[styles.unsupportedSub, { color: theme.colors.onSurfaceVariant }]}>
            {hasInAppBrowserPreview
              ? 'Tap below to read this PDF without leaving the app.'
              : 'Open this PDF in your preferred app to view it.'}
          </Text>
          {hasInAppBrowserPreview && (
            <TouchableOpacity
              onPress={handleOpenInBrowser}
              style={[styles.openButton, { backgroundColor: theme.colors.primary }]}
              activeOpacity={0.85}
              disabled={browserOpening}
              accessibilityRole="button"
              accessibilityLabel="Preview PDF in app"
            >
              {browserOpening ? (
                <ActivityIndicator color={theme.colors.onPrimary} size="small" />
              ) : (
                <Ionicons name="eye-outline" size={18} color={theme.colors.onPrimary} />
              )}
              <Text style={[styles.openButtonText, { color: theme.colors.onPrimary }]}>
                Preview in app
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleOpenExternally}
            style={[
              styles.openButton,
              hasInAppBrowserPreview ? styles.openButtonSecondary : { backgroundColor: theme.colors.primary },
              hasInAppBrowserPreview && { borderColor: theme.colors.primary },
            ]}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Open PDF with another app"
          >
            <Ionicons
              name="open-outline"
              size={18}
              color={hasInAppBrowserPreview ? theme.colors.primary : theme.colors.onPrimary}
            />
            <Text
              style={[
                styles.openButtonText,
                { color: hasInAppBrowserPreview ? theme.colors.primary : theme.colors.onPrimary },
              ]}
            >
              {hasInAppBrowserPreview ? 'Open in another app' : 'Open PDF'}
            </Text>
          </TouchableOpacity>
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
    // bundled for these types; we open the share sheet (or, when we have a
    // remote URL for an Office doc, the in-app Google Docs viewer) so the
    // user has a route forward instead of getting stuck on a blank screen.
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
          {hasInAppBrowserPreview
            ? 'Preview document'
            : kind === 'unsupported'
              ? 'Preview not available'
              : 'Open with system player'}
        </Text>
        <Text style={[styles.unsupportedSub, { color: theme.colors.onSurfaceVariant }]}>
          {hasInAppBrowserPreview
            ? 'Read this document inline without leaving the app.'
            : 'This file type opens best in another app on your device.'}
        </Text>
        {hasInAppBrowserPreview && (
          <TouchableOpacity
            onPress={handleOpenInBrowser}
            style={[styles.openButton, { backgroundColor: theme.colors.primary }]}
            activeOpacity={0.85}
            disabled={browserOpening}
            accessibilityRole="button"
            accessibilityLabel="Preview document in app"
          >
            {browserOpening ? (
              <ActivityIndicator color={theme.colors.onPrimary} size="small" />
            ) : (
              <Ionicons name="eye-outline" size={18} color={theme.colors.onPrimary} />
            )}
            <Text style={[styles.openButtonText, { color: theme.colors.onPrimary }]}>
              Preview in app
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={handleOpenExternally}
          style={[
            styles.openButton,
            hasInAppBrowserPreview ? styles.openButtonSecondary : { backgroundColor: theme.colors.primary },
            hasInAppBrowserPreview && { borderColor: theme.colors.primary },
          ]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Open with another app"
        >
          <Ionicons
            name="open-outline"
            size={18}
            color={hasInAppBrowserPreview ? theme.colors.primary : theme.colors.onPrimary}
          />
          <Text
            style={[
              styles.openButtonText,
              { color: hasInAppBrowserPreview ? theme.colors.primary : theme.colors.onPrimary },
            ]}
          >
            {hasInAppBrowserPreview ? 'Open in another app' : 'Open'}
          </Text>
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
  openButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
  },
  openButtonText: { fontSize: 15, fontWeight: '600' },
});

export default FilePreviewScreen;
