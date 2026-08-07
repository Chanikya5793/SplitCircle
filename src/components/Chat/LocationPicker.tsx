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
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import type { Region } from 'react-native-maps';
import { Button, Text } from 'react-native-paper';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addCompletionsListener,
  isPlaceSearchAvailable,
  resolveCompletion,
  searchNearby,
  searchPlaces,
  updateCompletionQuery,
  type PlaceCompletion,
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

/** Visible height of the sheet when resting. Its FULL height is derived per
 *  device from the safe area, so the collapse offset is a runtime value. */
const SHEET_COLLAPSED_H = 236;
/** Extra downward travel past collapsed that dismisses the whole picker. */
const DISMISS_TRAVEL = 110;
/** Shared so every sheet movement settles with the same weight. */
const SHEET_SPRING = { damping: 22, stiffness: 190, mass: 0.9 } as const;

const MAP_KINDS: { id: MapKind; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { id: 'standard', icon: 'map-outline', label: 'Standard' },
  { id: 'satellite', icon: 'earth-outline', label: 'Satellite' },
  { id: 'hybrid', icon: 'globe-outline', label: 'Hybrid' },
];

const isExpoGo = Constants.appOwnership === 'expo';

/**
 * Join address parts, dropping any that a previous part already covers.
 *
 * Reverse geocoding hands back overlapping fields — `name` is typically the
 * whole street line and `street` just the street, so a naive join repeats
 * itself. Substring containment catches that without needing to know which
 * field is which.
 */
const compactAddress = (parts: (string | null | undefined)[]): string => {
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw?.trim();
    if (!part) continue;
    const lower = part.toLowerCase();
    if (out.some((existing) => existing.toLowerCase().includes(lower))) continue;
    out.push(part);
  }
  return out.join(', ');
};

/**
 * The pin sits this far ABOVE the map's centre.
 *
 * The map is `absoluteFill` and so reports the centre of the whole screen,
 * but the sheet covers the bottom of it — a pin drawn at the true centre sits
 * awkwardly low and close to the sheet. So the pin is centred in the VISIBLE
 * strip instead, and the two helpers below convert between the two frames.
 *
 * They are defined as a pair on purpose: the read path and the write path must
 * apply the same offset in opposite directions, and a mismatch between them is
 * exactly the "pin points somewhere other than what you send" bug.
 */
const PIN_OFFSET_Y = SHEET_COLLAPSED_H / 2;

/** The coordinate actually under the pin, given the map's current region. */
const coordinateUnderPin = (region: Region): { latitude: number; longitude: number } => ({
  // Screen y decreases upward while latitude increases, hence the addition.
  latitude: region.latitude + (PIN_OFFSET_Y / SCREEN_H) * region.latitudeDelta,
  longitude: region.longitude,
});

/** The region to move to so that `latitude`/`longitude` ends up under the pin. */
const regionForPin = (latitude: number, longitude: number, delta: number): Region => ({
  latitude: latitude - (PIN_OFFSET_Y / SCREEN_H) * delta,
  longitude,
  latitudeDelta: delta,
  longitudeDelta: delta * ASPECT_RATIO,
});

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
  const [completions, setCompletions] = useState<PlaceCompletion[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const mapRef = useRef<MapViewRef>(null);
  const isMountedRef = useRef(true);
  const isVisibleRef = useRef(visible);
  const reverseGeocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the nearby list was last computed, to decide on "Search this area". */
  const nearbyAnchorRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const regionRef = useRef<Region | null>(null);
  /** Plain ref, not `useAnimatedRef`: this exists only to declare gesture
   *  simultaneity, and the scroll offset already arrives via the handler. */
  const listRef = useRef<any>(null);
  /** Read by the keyboard handlers, which are created once and must not close
   *  over a stale render's values. */
  const searchFocusedRef = useRef(false);
  const collapseOffsetRef = useRef(0);

  const mapsApiKeyAvailable = hasGoogleMapsApiKey();

  // ── Sheet ────────────────────────────────────────────────────────────────
  // Starts collapsed. Dragging past collapsed by DISMISS_TRAVEL closes the
  // picker outright, per DESIGN.md's rule that a full-screen overlay is never
  // something you can only ✕ out of.
  /**
   * ONE fixed height, position driven purely by `translateY`.
   *
   * This previously animated `height` and `bottom` from React state, which are
   * LAYOUT properties: they do not animate at all, they snap, and they snap on
   * the JS thread. Every keystroke that flipped search mode and every keyboard
   * appearance forced a synchronous re-layout of the whole sheet — that was the
   * choppiness. A constant height moved by a transform runs entirely on the UI
   * thread, and the keyboard is absorbed by scroll padding rather than by
   * resizing anything.
   */
  const sheetH = Math.max(320, SCREEN_H - insets.top - 78);
  const collapseOffset = Math.max(0, sheetH - SHEET_COLLAPSED_H);

  const sheetY = useSharedValue(collapseOffset);
  const sheetStart = useSharedValue(collapseOffset);

  const expandSheet = useCallback(() => {
    sheetY.value = withSpring(0, SHEET_SPRING);
  }, [sheetY]);

  const collapseSheet = useCallback(() => {
    sheetY.value = withSpring(collapseOffset, SHEET_SPRING);
  }, [sheetY, collapseOffset]);

  const requestClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  /**
   * Drag anywhere on the sheet, and hand off cleanly to the list inside it.
   *
   * The pan used to be bound to the grabber alone, so the sheet could only be
   * moved by a 40pt target most people never aimed at — everywhere else it
   * simply ignored the finger. It now covers the whole surface and negotiates
   * with the scroll view:
   *
   *   - not fully expanded  → the drag always moves the SHEET, and the list is
   *     scroll-disabled so it cannot swallow the gesture;
   *   - expanded, list at top, pulling DOWN → the sheet takes over, which is
   *     how you collapse without hunting for the handle;
   *   - expanded, list scrolled → the list keeps its gesture untouched.
   *
   * `activeOffsetY` means a tap on a result still registers as a tap: the pan
   * only claims the gesture once the finger has actually travelled.
   */
  const scrollOffset = useSharedValue(0);
  const claimedByList = useSharedValue(false);

  const onListScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollOffset.value = event.contentOffset.y;
    },
  });

  const sheetGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    // Both recognisers stay alive; the guards in onUpdate decide which one
    // actually moves. Without this they compete and the loser's frames are
    // dropped, which feels exactly like the stutter being reported.
    .simultaneousWithExternalGesture(listRef)
    .onStart(() => {
      sheetStart.value = sheetY.value;
      // Expanded AND already scrolled means this drag belongs to the list.
      claimedByList.value = sheetY.value <= 1 && scrollOffset.value > 1;
    })
    .onUpdate((event) => {
      if (claimedByList.value) return;
      // Expanded and at the top: only a downward pull moves the sheet, so an
      // upward flick still scrolls the list rather than fighting it.
      if (sheetY.value <= 1 && event.translationY < 0) return;
      const next = sheetStart.value + event.translationY;
      // Rubber-band above the expanded stop so it feels bounded, not broken.
      sheetY.value = next < 0 ? next / 3 : next;
    })
    .onEnd((event) => {
      if (claimedByList.value) return;
      const projected = sheetY.value + event.velocityY * 0.12;
      if (projected > collapseOffset + DISMISS_TRAVEL) {
        sheetY.value = withTiming(sheetH, { duration: 200 });
        runOnJS(requestClose)();
        return;
      }
      const midpoint = collapseOffset / 2;
      sheetY.value = withSpring(projected > midpoint ? collapseOffset : 0, SHEET_SPRING);
    });

  /**
   * Searching takes over the sheet.
   *
   * Previously "Selected location / note / Send" stayed pinned above the
   * results, which pushed the suggestions below the fold AND showed a stale
   * address contradicting the fresh list. While you are typing, the only thing
   * that matters is the suggestions.
   */
  const inSearchMode = searchFocused || searchQuery.trim().length > 0;

  useEffect(() => {
    if (inSearchMode) expandSheet();
  }, [inSearchMode, expandSheet]);

  useEffect(() => {
    collapseOffsetRef.current = collapseOffset;
  }, [collapseOffset]);

  useEffect(() => {
    searchFocusedRef.current = searchFocused;
  }, [searchFocused]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetY.value }],
  }));

  /**
   * The list only scrolls once the sheet is up. Collapsed, a drag inside it
   * should raise the sheet — otherwise the list quietly absorbs the gesture
   * and the sheet feels stuck.
   */
  const [listScrollEnabled, setListScrollEnabled] = useState(false);
  useAnimatedReaction(
    () => sheetY.value <= 1,
    (expanded, previous) => {
      if (expanded !== previous) runOnJS(setListScrollEnabled)(expanded);
    },
    [],
  );

  // ── Chrome that slides away while searching ───────────────────────────
  // TRANSFORM ONLY. DESIGN.md's native-material kill list: a Reanimated
  // opacity animation anywhere above the iOS 26 glass makes it render as
  // nothing, so these slide out rather than fade.
  const chromeShift = useSharedValue(0);
  useEffect(() => {
    chromeShift.value = withTiming(inSearchMode ? 1 : 0, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSearchMode]);

  const chromeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: chromeShift.value * 120 }],
  }));

  // Pin rises while the map is moving, settles when it stops.
  const pinLift = useSharedValue(0);
  useEffect(() => {
    pinLift.value = withSpring(isDragging ? -8 : 0, { damping: 14, stiffness: 260 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);
  const pinStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: pinLift.value }],
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
  // Suggestions arrive continuously from the native completer, and it can emit
  // more than once per keystroke as better matches resolve.
  useEffect(() => {
    const sub = addCompletionsListener((items) => {
      if (!isMountedRef.current) return;
      setCompletions(items);
      setIsSearching(false);
    });
    return () => sub.remove();
  }, []);

  /**
   * Track the keyboard so the sheet can sit ON TOP of it.
   *
   * Without this the results list rendered underneath the keyboard: live
   * search was producing suggestions the user could not see, which made
   * as-you-type look broken even when it was working.
   */
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
      // Ride the keyboard's OWN curve. iOS reports the duration it is about to
      // use; matching it makes the sheet and the keys arrive together instead
      // of as two separate movements, which is most of what reads as "choppy".
      sheetY.value = withTiming(0, {
        duration: Math.max(160, (e.duration ?? 250)),
        easing: Easing.bezier(0.17, 0.59, 0.4, 1),
      });
    });
    const onHide = Keyboard.addListener(hideEvent, (e) => {
      setKeyboardHeight(0);
      if (!searchFocusedRef.current) {
        sheetY.value = withTiming(collapseOffsetRef.current, {
          duration: Math.max(160, (e?.duration ?? 250)),
          easing: Easing.bezier(0.17, 0.59, 0.4, 1),
        });
      }
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    sheetY.value = collapseOffset;
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
      regionRef.current = regionForPin(latitude, longitude, DEFAULT_DELTA);
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
        // `name` is usually the full street line and `street` the street alone,
        // so joining both blindly produced "912 N Walnut St, N Walnut St,
        // Maryville". Country is dropped whenever a region is known — nobody
        // sharing a pin down the road needs "United States" on the end.
        const line = compactAddress([
          addr.name,
          addr.street,
          addr.city,
          addr.region,
          addr.region ? undefined : addr.country,
        ]);
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
    const under = coordinateUnderPin(region);
    setSelectedLocation(under);
    // Moving the map means the pin is no longer "the place you picked" — drop
    // the name so the sheet can't caption a new coordinate with an old venue.
    setPlaceName(null);

    const anchor = nearbyAnchorRef.current;
    if (anchor && metresBetween(anchor, under) > 800) {
      setShowSearchArea(true);
    }

    if (reverseGeocodeTimerRef.current) clearTimeout(reverseGeocodeTimerRef.current);
    reverseGeocodeTimerRef.current = setTimeout(() => {
      void fetchAddress(under.latitude, under.longitude);
    }, Platform.OS === 'android' ? 300 : 120);
  };

  const goToPlace = useCallback(
    (place: { latitude: number; longitude: number; name?: string; address?: string }) => {
      selectionHaptic();
      Keyboard.dismiss();
      mapRef.current?.animateToRegion(
        regionForPin(place.latitude, place.longitude, FOCUS_DELTA),
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
    mapRef.current?.animateToRegion(regionForPin(latitude, longitude, FOCUS_DELTA), 600);
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
            ? coordinateUnderPin(regionRef.current)
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
      setCompletions([]);
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    // Short debounce only — the completer is local and incremental, so this is
    // about not re-rendering mid-keystroke rather than about cost.
    searchDebounceRef.current = setTimeout(() => {
      void updateCompletionQuery(next, regionRef.current
        ? coordinateUnderPin(regionRef.current)
        : undefined);
    }, 120);
  };

  /** Resolve a tapped suggestion into a real coordinate, then fly there. */
  const chooseCompletion = useCallback(
    async (item: PlaceCompletion) => {
      setIsSearching(true);
      const place = await resolveCompletion(item.id);
      setIsSearching(false);
      if (!place) {
        appAlert('Could not open that place', 'Try selecting it again.');
        return;
      }
      goToPlace(place);
    },
    [goToPlace],
  );

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
                  // Offset so the user's actual position starts UNDER the pin
                  // rather than under the sheet.
                  initialRegion={regionForPin(
                    currentLocation.coords.latitude,
                    currentLocation.coords.longitude,
                    DEFAULT_DELTA,
                  )}
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
              {/* Zero-size anchor sitting on the map's TRUE centre. The dot
                  marks the exact coordinate we will send; the teardrop floats
                  above it. Anchoring this way means the thing the user aims
                  with and the thing we transmit are the same point. */}
              <View style={styles.pinAnchor}>
                <Animated.View style={[styles.pinIcon, pinStyle]}>
                  <Ionicons name="location" size={38} color={theme.colors.primary} />
                </Animated.View>
                <View
                  style={[
                    styles.pinDot,
                    { borderColor: theme.colors.primary, backgroundColor: theme.colors.background },
                  ]}
                />
              </View>
            </View>
          )}

          {/* ── Floating glass search ─────────────────────────────────── */}
          <View style={[styles.searchWrap, { top: insets.top + 10 }]} pointerEvents="box-none">
            <GlassCard role="floating" radius="lg" style={styles.searchCard} contentStyle={styles.searchCardContent}>
              <TouchableOpacity
                onPress={() => {
                  // Back out of searching first, close the picker second — a
                  // single chevron that always dismissed made escaping a typo
                  // mean losing the whole screen.
                  if (inSearchMode) {
                    Keyboard.dismiss();
                    setSearchFocused(false);
                    setSearchQuery('');
                    setCompletions([]);
                    collapseSheet();
                    return;
                  }
                  handleClose();
                }}
                hitSlop={10}
                style={styles.searchIcon}
                accessibilityLabel={inSearchMode ? 'Cancel search' : 'Close'}
              >
                <Ionicons name="chevron-back" size={22} color={theme.colors.onSurface} />
              </TouchableOpacity>
              <TextInput
                style={[styles.searchInput, { color: theme.colors.onSurface }]}
                placeholder="Search places or addresses"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                value={searchQuery}
                onChangeText={onQueryChange}
                onFocus={() => {
                  setSearchFocused(true);
                  expandSheet();
                }}
                onBlur={() => setSearchFocused(false)}
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

          {/* Map type + locate.
              Four stacked bubbles collided with the map's own street labels and
              the three type icons were near-indistinguishable at that size. One
              labelled segmented pill reads at a glance and occupies a single
              band; locate keeps its own target near the thumb. */}
          {permissionGranted && !loading && (
            <Animated.View
              style={[styles.mapKindWrap, { top: insets.top + 72 }, chromeStyle]}
              pointerEvents={inSearchMode ? 'none' : 'box-none'}
            >
              <GlassCard role="floating" radius="pill" style={styles.mapKindCard} contentStyle={styles.mapKindContent}>
                {MAP_KINDS.map((kind) => {
                  const active = mapKind === kind.id;
                  return (
                    <TouchableOpacity
                      key={kind.id}
                      onPress={() => {
                        selectionHaptic();
                        setMapKind(kind.id);
                      }}
                      style={[
                        styles.mapKindItem,
                        active && { backgroundColor: theme.colors.primary },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text
                        style={[
                          styles.mapKindLabel,
                          { color: active ? theme.colors.onPrimary : theme.colors.onSurfaceVariant },
                        ]}
                      >
                        {kind.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </GlassCard>
            </Animated.View>
          )}

          {permissionGranted && !loading && (
            <Animated.View
              style={[styles.locateWrap, { bottom: SHEET_COLLAPSED_H + 18 }, chromeStyle]}
              pointerEvents={inSearchMode ? 'none' : 'box-none'}
            >
              <TouchableOpacity onPress={goToCurrentLocation} accessibilityLabel="Go to my location">
                <GlassCard role="floating" radius={24} style={styles.locateButton} contentStyle={styles.locateContent}>
                  <Ionicons name="locate" size={20} color={theme.colors.primary} />
                </GlassCard>
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* ── Search this area ──────────────────────────────────────── */}
          {showSearchArea && !searchQuery.trim() && (
            <View style={[styles.searchAreaWrap, { bottom: SHEET_COLLAPSED_H + 80 }]} pointerEvents="box-none">
              <TouchableOpacity
                onPress={() => {
                  const region = regionRef.current;
                  if (!region) return;
                  lightHaptic();
                  const under = coordinateUnderPin(region);
                  void loadNearby(under.latitude, under.longitude);
                }}
              >
                <GlassCard role="floating" radius="lg" style={styles.searchAreaCard} contentStyle={styles.searchAreaContent}>
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
            <Animated.View
              style={[styles.sheet, { height: sheetH }, sheetStyle]}
            >
              <GestureDetector gesture={sheetGesture}>
              <GlassCard role="floating" radius="xl" style={styles.sheetCard} contentStyle={styles.sheetContent}>
                {/* Tapping the collapsed sheet opens it — the grabber is a hint,
                    not the only way in. */}
                <TouchableOpacity
                  activeOpacity={1}
                  onPress={() => {
                    if (!inSearchMode) {
                      lightHaptic();
                      expandSheet();
                    }
                  }}
                  style={styles.grabZone}
                  accessibilityLabel="Expand place list"
                >
                  <View style={[styles.grabber, { backgroundColor: theme.colors.onSurfaceVariant }]} />
                </TouchableOpacity>

                {!inSearchMode && (
                <>
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
                </>
                )}

                <Animated.ScrollView
                  ref={listRef}
                  style={styles.list}
                  onScroll={onListScroll}
                  scrollEventThrottle={16}
                  // Off while collapsed so a drag there moves the SHEET rather
                  // than being eaten by a list that has nowhere to go.
                  scrollEnabled={listScrollEnabled}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  showsVerticalScrollIndicator={false}
                >
                  {inSearchMode ? (
                    <>
                      {completions.length === 0 && !isSearching && searchQuery.trim().length > 1 && (
                        <Text style={[styles.emptyHint, { color: theme.colors.onSurfaceVariant }]}>
                          {`No matches for \u201C${searchQuery.trim()}\u201D yet.`}
                        </Text>
                      )}
                      {completions.map((item) => (
                        <TouchableOpacity
                          key={`c-${item.id}-${item.title}`}
                          style={styles.row}
                          onPress={() => void chooseCompletion(item)}
                        >
                          <Ionicons name="location-outline" size={18} color={theme.colors.primary} />
                          <View style={styles.rowText}>
                            <Text numberOfLines={1} style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                              {item.title}
                            </Text>
                            {!!item.subtitle && (
                              <Text
                                numberOfLines={1}
                                variant="bodySmall"
                                style={{ color: theme.colors.onSurfaceVariant }}
                              >
                                {item.subtitle}
                              </Text>
                            )}
                          </View>
                        </TouchableOpacity>
                      ))}
                    </>
                  ) : (
                    <>
                      {sections.length === 0 && (
                        <Text style={[styles.emptyHint, { color: theme.colors.onSurfaceVariant }]}>
                          Drag the map to place the pin, or search above.
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
                    </>
                  )}
                  {/* The keyboard is absorbed HERE rather than by resizing the
                      sheet — padding is cheap and does not re-lay-out the
                      surface every time the keyboard moves. */}
                  <View style={{ height: keyboardHeight + insets.bottom + 24 }} />
                </Animated.ScrollView>
              </GlassCard>
              </GestureDetector>
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

  /**
   * Spans the WHOLE map, because the map is `absoluteFill` and therefore
   * reports the centre of the full screen. This used to stop short at
   * `bottom: SHEET_COLLAPSED_H`, so the pin was centred in the area above the
   * sheet while the coordinate came from the screen's centre — roughly 118pt
   * of disagreement between where the pin pointed and what got sent.
   */
  pinWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: SHEET_COLLAPSED_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Zero-size, so its own centre IS the map centre. */
  pinAnchor: { width: 0, height: 0, alignItems: 'center', justifyContent: 'center' },
  /**
   * `bottom: 0` against a zero-height anchor puts the glyph's baseline on the
   * centre point, so the teardrop's tip rests on the dot rather than the
   * icon's midpoint sitting there — the second, smaller half of the same bug.
   */
  pinIcon: { position: 'absolute', bottom: 0 },
  pinDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },

  edgeBackZone: { position: 'absolute', left: 0, width: 28, bottom: SHEET_COLLAPSED_H },
  searchWrap: { position: 'absolute', left: 12, right: 12 },
  searchCard: { width: '100%' },
  searchCardContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 4 },
  searchIcon: { paddingHorizontal: 8, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 10 },

  mapKindWrap: { position: 'absolute', right: 12 },
  mapKindCard: {},
  mapKindContent: { flexDirection: 'row', padding: 3, gap: 2 },
  mapKindItem: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999 },
  mapKindLabel: { fontSize: 12, fontWeight: '700' },
  locateWrap: { position: 'absolute', right: 12 },
  locateButton: { width: 48, height: 48 },
  locateContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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
