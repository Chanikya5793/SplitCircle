import { MapErrorBoundary } from '@/components/Chat/MapErrorBoundary';
import { GlassCard } from '@/components/ui/GlassCard';
import { useTheme } from '@/context/ThemeContext';
import {
  getRecentPlaces,
  rememberPlace,
  type RecentPlace,
} from '@/services/recentPlacesService';
import { appAlert } from '@/utils/appAlert';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { hasGoogleMapsApiKey } from '@/utils/hasGoogleMapsApiKey';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Keyboard,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import type { Region } from 'react-native-maps';
import { Button, Text } from 'react-native-paper';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isPlaceSearchAvailable,
  searchNearby,
  searchPlaces,
  type PlaceResult,
} from '../../../modules/splitcircle-places';

// Lazy load MapView to prevent crashes on Android production builds
const MapView = React.lazy(() => import('react-native-maps').then((mod) => ({ default: mod.default })));

type MapViewRef = InstanceType<typeof import('react-native-maps').default>;
type RegionChangeDetails = { isGesture?: boolean };
type MapKind = 'standard' | 'satellite' | 'hybrid';

interface LocationPickerProps {
  visible: boolean;
  onClose: () => void;
  onSendLocation: (
    location: { latitude: number; longitude: number; address?: string },
    /** Optional note sent as the message body, e.g. "meet me by the side door". */
    caption?: string,
  ) => void;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const ASPECT_RATIO = SCREEN_W / SCREEN_H;

/**
 * Opening span. The old 0.005 framed a couple of streets with no landmarks in
 * sight — precise, but you had to zoom OUT before you could tell where you
 * were. This orients first; picking a result tightens it back down.
 */
const DEFAULT_DELTA = 0.02;
/** Span used when jumping to a specific chosen place, where precision matters. */
const FOCUS_DELTA = 0.006;
const LIVE_LOCATION_DURATION_MINUTES = 15;

const SHEET_EXPANDED_H = Math.min(SCREEN_H * 0.62, 520);
const SHEET_COLLAPSED_H = 236;
/** How far the sheet sits below its expanded position when collapsed. */
const COLLAPSE_OFFSET = SHEET_EXPANDED_H - SHEET_COLLAPSED_H;
/** Extra downward travel past collapsed that dismisses the whole picker. */
const DISMISS_TRAVEL = 110;

const MAP_KINDS: { id: MapKind; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { id: 'standard', icon: 'map-outline', label: 'Standard' },
  { id: 'satellite', icon: 'earth-outline', label: 'Satellite' },
  { id: 'hybrid', icon: 'globe-outline', label: 'Hybrid' },
];

const isExpoGo = Constants.appOwnership === 'expo';

/** Rough metres between two coordinates — good enough to decide whether the map
 *  has been panned far enough to justify offering "Search this area". */
const metresBetween = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number => {
  const dLat = (a.latitude - b.latitude) * 111_320;
  const dLon =
    (a.longitude - b.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
};

export const LocationPicker = ({ visible, onClose, onSendLocation }: LocationPickerProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const [currentLocation, setCurrentLocation] = useState<Location.LocationObject | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [caption, setCaption] = useState('');
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [nearby, setNearby] = useState<PlaceResult[]>([]);
  const [recents, setRecents] = useState<RecentPlace[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [mapKind, setMapKind] = useState<MapKind>('standard');
  const [showSearchArea, setShowSearchArea] = useState(false);

  const mapRef = useRef<MapViewRef>(null);
  const isMountedRef = useRef(true);
  const isVisibleRef = useRef(visible);
  const reverseGeocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the nearby list was last computed, to decide on "Search this area". */
  const nearbyAnchorRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const regionRef = useRef<Region | null>(null);

  const mapsApiKeyAvailable = hasGoogleMapsApiKey();

  // ── Sheet ────────────────────────────────────────────────────────────────
  // Starts collapsed. Dragging past collapsed by DISMISS_TRAVEL closes the
  // picker outright, per DESIGN.md's rule that a full-screen overlay is never
  // something you can only ✕ out of.
  const sheetY = useSharedValue(COLLAPSE_OFFSET);
  const sheetStart = useSharedValue(COLLAPSE_OFFSET);

  const expandSheet = useCallback(() => {
    sheetY.value = withSpring(0, { damping: 20, stiffness: 180 });
  }, [sheetY]);

  const collapseSheet = useCallback(() => {
    sheetY.value = withSpring(COLLAPSE_OFFSET, { damping: 20, stiffness: 180 });
  }, [sheetY]);

  const requestClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const sheetGesture = Gesture.Pan()
    .onStart(() => {
      sheetStart.value = sheetY.value;
    })
    .onUpdate((event) => {
      const next = sheetStart.value + event.translationY;
      // Rubber-band above the expanded stop so it feels bounded, not broken.
      sheetY.value = next < 0 ? next / 3 : next;
    })
    .onEnd((event) => {
      const projected = sheetY.value + event.velocityY * 0.12;
      if (projected > COLLAPSE_OFFSET + DISMISS_TRAVEL) {
        sheetY.value = withTiming(SHEET_EXPANDED_H, { duration: 180 });
        runOnJS(requestClose)();
        return;
      }
      const midpoint = COLLAPSE_OFFSET / 2;
      sheetY.value = withSpring(projected > midpoint ? COLLAPSE_OFFSET : 0, {
        damping: 20,
        stiffness: 180,
      });
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetY.value }],
  }));

  /**
   * Left-edge swipe-back, per DESIGN.md: a full-screen overlay behaves like a
   * pushed screen rather than a trap, so iOS's back gesture has to work here
   * even though this is a modal. `activeOffsetX` keeps it from stealing
   * horizontal drags that belong to the map.
   */
  const edgeBack = Gesture.Pan()
    .activeOffsetX(20)
    .failOffsetY([-14, 14])
    .onEnd((event) => {
      if (event.translationX > 70 || event.velocityX > 700) {
        runOnJS(requestClose)();
      }
    });

  // ── Lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (reverseGeocodeTimerRef.current) clearTimeout(reverseGeocodeTimerRef.current);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    isVisibleRef.current = visible;
    if (!visible) {
      if (reverseGeocodeTimerRef.current) {
        clearTimeout(reverseGeocodeTimerRef.current);
        reverseGeocodeTimerRef.current = null;
      }
      setIsDragging(false);
      return;
    }
    sheetY.value = COLLAPSE_OFFSET;
    setSearchQuery('');
    setResults([]);
    setShowSearchArea(false);
    void checkPermissionsAndGetLocation();
    void getRecentPlaces().then((list) => {
      if (isMountedRef.current) setRecents(list);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const checkPermissionsAndGetLocation = async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (!isMountedRef.current || !isVisibleRef.current) return;

      if (status !== 'granted') {
        setPermissionGranted(false);
        setLoading(false);
        return;
      }

      setPermissionGranted(true);
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      if (!isMountedRef.current || !isVisibleRef.current) return;

      setCurrentLocation(location);
      const { latitude, longitude } = location.coords;
      setSelectedLocation({ latitude, longitude });
      regionRef.current = {
        latitude,
        longitude,
        latitudeDelta: DEFAULT_DELTA,
        longitudeDelta: DEFAULT_DELTA * ASPECT_RATIO,
      };
      await fetchAddress(latitude, longitude);
      void loadNearby(latitude, longitude);
    } catch (error) {
      console.error('Error getting location:', error);
      if (isMountedRef.current && isVisibleRef.current) {
        appAlert('Error', 'Could not fetch location');
      }
    } finally {
      if (isMountedRef.current && isVisibleRef.current) setLoading(false);
    }
  };

  const loadNearby = useCallback(async (latitude: number, longitude: number) => {
    nearbyAnchorRef.current = { latitude, longitude };
    const found = await searchNearby(latitude, longitude, 1500);
    if (isMountedRef.current && isVisibleRef.current) {
      setNearby(found);
      setShowSearchArea(false);
    }
  }, []);

  const fetchAddress = async (latitude: number, longitude: number) => {
    try {
      const reverseGeocode = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (reverseGeocode.length > 0) {
        const addr = reverseGeocode[0];
        const line = [addr.name, addr.street, addr.city, addr.region, addr.country]
          .filter(Boolean)
          .join(', ');
        if (isMountedRef.current && isVisibleRef.current) setAddress(line);
      }
    } catch {
      if (isMountedRef.current && isVisibleRef.current) {
        setAddress(`${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
      }
    }
  };

  // ── Map ──────────────────────────────────────────────────────────────────
  const handleRegionChangeStart = () => setIsDragging(true);

  const handleRegionChangeComplete = (region: Region, details?: RegionChangeDetails) => {
    if (Platform.OS === 'android' && details && details.isGesture === false) {
      setIsDragging(false);
      return;
    }
    setIsDragging(false);
    regionRef.current = region;
    setSelectedLocation({ latitude: region.latitude, longitude: region.longitude });
    // Moving the map means the pin is no longer "the place you picked" — drop
    // the name so the sheet can't caption a new coordinate with an old venue.
    setPlaceName(null);

    const anchor = nearbyAnchorRef.current;
    if (anchor && metresBetween(anchor, region) > 800) {
      setShowSearchArea(true);
    }

    if (reverseGeocodeTimerRef.current) clearTimeout(reverseGeocodeTimerRef.current);
    reverseGeocodeTimerRef.current = setTimeout(() => {
      void fetchAddress(region.latitude, region.longitude);
    }, Platform.OS === 'android' ? 300 : 120);
  };

  const goToPlace = useCallback(
    (place: { latitude: number; longitude: number; name?: string; address?: string }) => {
      selectionHaptic();
      Keyboard.dismiss();
      mapRef.current?.animateToRegion(
        {
          latitude: place.latitude,
          longitude: place.longitude,
          latitudeDelta: FOCUS_DELTA,
          longitudeDelta: FOCUS_DELTA * ASPECT_RATIO,
        },
        600,
      );
      setSelectedLocation({ latitude: place.latitude, longitude: place.longitude });
      setResults([]);
      setSearchQuery('');
      if (place.name) setPlaceName(place.name);
      if (place.address) setAddress(place.address);
      void fetchAddress(place.latitude, place.longitude);
      collapseSheet();
    },
    [collapseSheet],
  );

  const goToCurrentLocation = () => {
    if (!currentLocation) return;
    lightHaptic();
    const { latitude, longitude } = currentLocation.coords;
    mapRef.current?.animateToRegion(
      {
        latitude,
        longitude,
        latitudeDelta: FOCUS_DELTA,
        longitudeDelta: FOCUS_DELTA * ASPECT_RATIO,
      },
      600,
    );
  };

  // ── Search ───────────────────────────────────────────────────────────────
  const runSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        setResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      try {
        if (isPlaceSearchAvailable()) {
          const near = regionRef.current
            ? { latitude: regionRef.current.latitude, longitude: regionRef.current.longitude }
            : undefined;
          const found = await searchPlaces(trimmed, near);
          if (isMountedRef.current) setResults(found);
          return;
        }
        // Fallback where the native module is absent: address-only geocoding.
        const geocoded = await Location.geocodeAsync(trimmed);
        if (isMountedRef.current) {
          setResults(
            geocoded.slice(0, 10).map((g) => ({
              name: trimmed,
              address: '',
              latitude: g.latitude,
              longitude: g.longitude,
            })),
          );
        }
      } catch (error) {
        console.warn('Place search failed', error);
        if (isMountedRef.current) setResults([]);
      } finally {
        if (isMountedRef.current) setIsSearching(false);
      }
    },
    [],
  );

  // Live search. MKLocalSearch is free and tolerant of repeated calls, so the
  // debounce is purely about not thrashing the list while a word is half typed.
  const onQueryChange = (next: string) => {
    setSearchQuery(next);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!next.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchDebounceRef.current = setTimeout(() => void runSearch(next), 300);
  };

  // ── Send ─────────────────────────────────────────────────────────────────
  const handleSend = () => {
    if (!selectedLocation) return;
    setSending(true);
    const label = placeName ?? address ?? undefined;
    void rememberPlace({
      name: placeName ?? address ?? 'Dropped pin',
      address: address ?? '',
      latitude: selectedLocation.latitude,
      longitude: selectedLocation.longitude,
    });
    onSendLocation(
      {
        latitude: selectedLocation.latitude,
        longitude: selectedLocation.longitude,
        address: label,
      },
      caption.trim() || undefined,
    );
    setSending(false);
    handleClose();
  };

  const handleClose = () => {
    if (reverseGeocodeTimerRef.current) {
      clearTimeout(reverseGeocodeTimerRef.current);
      reverseGeocodeTimerRef.current = null;
    }
    mapRef.current = null;
    setCaption('');
    setResults([]);
    setPlaceName(null);
    requestClose();
  };

  const handleLiveLocation = async () => {
    if (isExpoGo) {
      appAlert(
        'Development Build Required',
        'Live location sharing requires a development or production build.',
      );
      return;
    }
    try {
      const { status: fg } = await Location.getForegroundPermissionsAsync();
      if (fg !== 'granted') {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          appAlert('Permission Denied', 'Foreground location permission is required first.');
          return;
        }
      }
      const { status: bg } = await Location.getBackgroundPermissionsAsync();
      if (bg !== 'granted') {
        await Location.requestBackgroundPermissionsAsync();
      }
      appAlert('Coming Soon', 'Live location sharing will be available in the next update.');
    } catch (error) {
      console.error('Live location error:', error);
      appAlert('Error', 'Could not enable live location.');
    }
  };

  const openSettings = async () => {
    if (Platform.OS === 'ios') {
      await Linking.openSettings();
    } else {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        { data: `package:${Constants.expoConfig?.android?.package ?? ''}` },
      );
    }
  };

  // ── Sheet content ────────────────────────────────────────────────────────
  const sections = useMemo(() => {
    if (searchQuery.trim()) {
      return [{ key: 'results', title: 'Results', items: results }];
    }
    const out: { key: string; title: string; items: (PlaceResult | RecentPlace)[] }[] = [];
    if (recents.length > 0) out.push({ key: 'recent', title: 'Recent', items: recents });
    if (nearby.length > 0) out.push({ key: 'nearby', title: 'Nearby', items: nearby });
    return out;
  }, [searchQuery, results, recents, nearby]);

  const subtitle = isDragging
    ? 'Locating…'
    : address ?? (selectedLocation
        ? `${selectedLocation.latitude.toFixed(5)}, ${selectedLocation.longitude.toFixed(5)}`
        : 'Move the map to choose a spot');

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <GestureHandlerRootView style={styles.root}>
        <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
          {/* ── Map, edge to edge ─────────────────────────────────────── */}
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={{ marginTop: 12, color: theme.colors.onSurface }}>Finding you…</Text>
            </View>
          ) : !permissionGranted ? (
            <View style={styles.centered}>
              <Ionicons name="location-outline" size={48} color={theme.colors.error} />
              <Text style={{ marginTop: 12, color: theme.colors.onSurface }}>
                Location permission needed
              </Text>
              <Button mode="contained" onPress={checkPermissionsAndGetLocation} style={{ marginTop: 20 }}>
                Grant permission
              </Button>
              <Button mode="text" onPress={openSettings} style={{ marginTop: 6 }}>
                Open settings
              </Button>
            </View>
          ) : currentLocation && mapsApiKeyAvailable ? (
            <MapErrorBoundary
              fallback={
                <View style={styles.centered}>
                  <Ionicons name="map-outline" size={50} color={theme.colors.primary} />
                  <Text style={{ marginTop: 12, color: theme.colors.onSurface }}>
                    Map unavailable right now
                  </Text>
                </View>
              }
            >
              <React.Suspense
                fallback={
                  <View style={styles.centered}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                  </View>
                }
              >
                <MapView
                  ref={(instance) => {
                    mapRef.current = instance as MapViewRef | null;
                  }}
                  style={StyleSheet.absoluteFill}
                  initialRegion={{
                    latitude: currentLocation.coords.latitude,
                    longitude: currentLocation.coords.longitude,
                    latitudeDelta: DEFAULT_DELTA,
                    longitudeDelta: DEFAULT_DELTA * ASPECT_RATIO,
                  }}
                  mapType={mapKind}
                  // Follows the APP's theme, not the system's. The app lets you
                  // force Light or Dark independently, and without this a dark
                  // app rendered a bright white map inside itself.
                  userInterfaceStyle={isDark ? 'dark' : 'light'}
                  showsUserLocation
                  showsMyLocationButton={false}
                  showsPointsOfInterests
                  showsCompass={false}
                  showsBuildings
                  toolbarEnabled={false}
                  moveOnMarkerPress={false}
                  onRegionChange={handleRegionChangeStart}
                  onRegionChangeComplete={handleRegionChangeComplete}
                />
              </React.Suspense>
            </MapErrorBoundary>
          ) : (
            <View style={styles.centered}>
              <Ionicons name="location" size={60} color={theme.colors.primary} />
              <Text style={{ marginTop: 16, color: theme.colors.onSurface, fontWeight: '600' }}>
                GPS location
              </Text>
              <Text
                style={{
                  marginTop: 8,
                  color: theme.colors.onSurfaceVariant,
                  textAlign: 'center',
                  paddingHorizontal: 32,
                }}
              >
                Map preview unavailable, but you can still share where you are.
              </Text>
            </View>
          )}

          {/* Left-edge back strip. Narrow and above the map so it can win the
              gesture there, but below the sheet so list scrolling is unaffected. */}
          <GestureDetector gesture={edgeBack}>
            <View style={[styles.edgeBackZone, { top: insets.top }]} />
          </GestureDetector>

          {/* Centre pin — the map moves under a fixed crosshair, so the pin is
              never a marker that can drift out of sync with the region. */}
          {permissionGranted && !loading && (
            <View style={styles.pinWrap} pointerEvents="none">
              <Ionicons
                name="location"
                size={38}
                color={theme.colors.primary}
                style={isDragging ? styles.pinLifted : undefined}
              />
              <View style={[styles.pinDot, { borderColor: theme.colors.primary }]} />
            </View>
          )}

          {/* ── Floating glass search ─────────────────────────────────── */}
          <View style={[styles.searchWrap, { top: insets.top + 10 }]} pointerEvents="box-none">
            <GlassCard radius="lg" style={styles.searchCard} contentStyle={styles.searchCardContent}>
              <TouchableOpacity onPress={handleClose} hitSlop={10} style={styles.searchIcon}>
                <Ionicons name="chevron-back" size={22} color={theme.colors.onSurface} />
              </TouchableOpacity>
              <TextInput
                style={[styles.searchInput, { color: theme.colors.onSurface }]}
                placeholder="Search places or addresses"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                value={searchQuery}
                onChangeText={onQueryChange}
                onFocus={expandSheet}
                onSubmitEditing={() => void runSearch(searchQuery)}
                returnKeyType="search"
                autoCorrect={false}
              />
              {isSearching ? (
                <ActivityIndicator size="small" color={theme.colors.primary} style={styles.searchIcon} />
              ) : searchQuery.length > 0 ? (
                <TouchableOpacity
                  onPress={() => {
                    setSearchQuery('');
                    setResults([]);
                  }}
                  hitSlop={10}
                  style={styles.searchIcon}
                >
                  <Ionicons name="close-circle" size={20} color={theme.colors.onSurfaceVariant} />
                </TouchableOpacity>
              ) : (
                <View style={styles.searchIcon}>
                  <Ionicons name="search" size={19} color={theme.colors.onSurfaceVariant} />
                </View>
              )}
            </GlassCard>
          </View>

          {/* ── Right-hand glass controls ─────────────────────────────── */}
          {permissionGranted && !loading && (
            <View style={[styles.sideControls, { top: insets.top + 74 }]} pointerEvents="box-none">
              {MAP_KINDS.map((kind) => (
                <TouchableOpacity
                  key={kind.id}
                  onPress={() => {
                    selectionHaptic();
                    setMapKind(kind.id);
                  }}
                  accessibilityLabel={`${kind.label} map`}
                  accessibilityState={{ selected: mapKind === kind.id }}
                >
                  <GlassCard radius={22} style={styles.sideButton} contentStyle={styles.sideButtonContent}>
                    <Ionicons
                      name={kind.icon}
                      size={19}
                      color={mapKind === kind.id ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                  </GlassCard>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={goToCurrentLocation} accessibilityLabel="Go to my location">
                <GlassCard radius={22} style={styles.sideButton} contentStyle={styles.sideButtonContent}>
                  <Ionicons name="locate" size={19} color={theme.colors.primary} />
                </GlassCard>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Search this area ──────────────────────────────────────── */}
          {showSearchArea && !searchQuery.trim() && (
            <View style={[styles.searchAreaWrap, { bottom: SHEET_COLLAPSED_H + 18 }]} pointerEvents="box-none">
              <TouchableOpacity
                onPress={() => {
                  const region = regionRef.current;
                  if (!region) return;
                  lightHaptic();
                  void loadNearby(region.latitude, region.longitude);
                }}
              >
                <GlassCard radius="lg" style={styles.searchAreaCard} contentStyle={styles.searchAreaContent}>
                  <Ionicons name="refresh" size={15} color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.onSurface, fontWeight: '600', fontSize: 13 }}>
                    Search this area
                  </Text>
                </GlassCard>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Bottom sheet ──────────────────────────────────────────── */}
          {permissionGranted && !loading && (
            <Animated.View style={[styles.sheet, { height: SHEET_EXPANDED_H }, sheetStyle]}>
              <GlassCard radius="xl" style={styles.sheetCard} contentStyle={styles.sheetContent}>
                <GestureDetector gesture={sheetGesture}>
                  <View style={styles.grabZone}>
                    <View style={[styles.grabber, { backgroundColor: theme.colors.onSurfaceVariant }]} />
                  </View>
                </GestureDetector>

                <View style={styles.selectedRow}>
                  <View style={styles.selectedText}>
                    <Text numberOfLines={1} style={[styles.selectedTitle, { color: theme.colors.onSurface }]}>
                      {placeName ?? 'Selected location'}
                    </Text>
                    <Text
                      numberOfLines={1}
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >
                      {subtitle}
                    </Text>
                  </View>
                </View>

                <TextInput
                  placeholder="Add a note (optional)"
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  value={caption}
                  onChangeText={setCaption}
                  maxLength={500}
                  onFocus={expandSheet}
                  style={[
                    styles.captionInput,
                    {
                      color: theme.colors.onSurface,
                      borderColor: theme.colors.outlineVariant,
                    },
                  ]}
                />

                <View style={styles.actionRow}>
                  <Button
                    mode="contained"
                    onPress={handleSend}
                    loading={sending}
                    disabled={isDragging || !selectedLocation}
                    style={styles.sendButton}
                    buttonColor={theme.colors.primary}
                  >
                    Send this location
                  </Button>
                  <TouchableOpacity
                    onPress={handleLiveLocation}
                    style={styles.liveButton}
                    accessibilityLabel={`Share live location for ${LIVE_LOCATION_DURATION_MINUTES} minutes`}
                  >
                    <Ionicons name="navigate-circle-outline" size={22} color={theme.colors.primary} />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  style={styles.list}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {sections.length === 0 && !isSearching && (
                    <Text style={[styles.emptyHint, { color: theme.colors.onSurfaceVariant }]}>
                      {searchQuery.trim()
                        ? `Nothing found for “${searchQuery.trim()}”.`
                        : 'Drag the map to place the pin, or search above.'}
                    </Text>
                  )}
                  {sections.map((section) => (
                    <View key={section.key}>
                      <Text style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                        {section.title}
                      </Text>
                      {section.items.map((item, index) => (
                        <TouchableOpacity
                          key={`${section.key}-${item.latitude},${item.longitude}-${index}`}
                          style={styles.row}
                          onPress={() =>
                            goToPlace({
                              latitude: item.latitude,
                              longitude: item.longitude,
                              name: item.name,
                              address: item.address,
                            })
                          }
                        >
                          <Ionicons
                            name={section.key === 'recent' ? 'time-outline' : 'location-outline'}
                            size={18}
                            color={theme.colors.primary}
                          />
                          <View style={styles.rowText}>
                            <Text numberOfLines={1} style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                              {item.name}
                            </Text>
                            {!!item.address && (
                              <Text
                                numberOfLines={1}
                                variant="bodySmall"
                                style={{ color: theme.colors.onSurfaceVariant }}
                              >
                                {item.address}
                              </Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                  <View style={{ height: insets.bottom + 16 }} />
                </ScrollView>
              </GlassCard>
            </Animated.View>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

  pinWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: SHEET_COLLAPSED_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinLifted: { transform: [{ translateY: -6 }] },
  pinDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    marginTop: -2,
  },

  edgeBackZone: { position: 'absolute', left: 0, width: 28, bottom: SHEET_COLLAPSED_H },
  searchWrap: { position: 'absolute', left: 12, right: 12 },
  searchCard: { width: '100%' },
  searchCardContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 4 },
  searchIcon: { paddingHorizontal: 8, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 10 },

  sideControls: { position: 'absolute', right: 12, gap: 8, alignItems: 'flex-end' },
  sideButton: { width: 44, height: 44 },
  sideButtonContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  searchAreaWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  searchAreaCard: {},
  searchAreaContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },

  sheet: { position: 'absolute', left: 8, right: 8, bottom: 0 },
  sheetCard: { flex: 1 },
  sheetContent: { flex: 1, paddingHorizontal: 16 },
  grabZone: { alignItems: 'center', paddingTop: 8, paddingBottom: 10, marginHorizontal: -16 },
  grabber: { width: 40, height: 4, borderRadius: 2, opacity: 0.5 },

  selectedRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selectedText: { flex: 1 },
  selectedTitle: { fontSize: 17, fontWeight: '700' },

  captionInput: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },

  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  sendButton: { flex: 1, borderRadius: 12 },
  liveButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },

  list: { marginTop: 14, flex: 1 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  rowText: { flex: 1 },
  emptyHint: { fontSize: 13, paddingVertical: 12, textAlign: 'center' },
});
