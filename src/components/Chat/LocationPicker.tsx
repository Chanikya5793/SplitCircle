import { MapErrorBoundary } from '@/components/Chat/MapErrorBoundary';
import { useTheme } from '@/context/ThemeContext';
import { hasGoogleMapsApiKey } from '@/utils/hasGoogleMapsApiKey';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, Linking, Modal, Platform, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import type { Region } from 'react-native-maps';
import { Button, Text } from 'react-native-paper';

// Lazy load MapView to prevent crashes on Android production builds
const MapView = React.lazy(() => import('react-native-maps').then(mod => ({ default: mod.default })));

// Type for MapView ref
type MapViewRef = InstanceType<typeof import('react-native-maps').default>;
type RegionChangeDetails = { isGesture?: boolean };

interface LocationPickerProps {
  visible: boolean;
  onClose: () => void;
  onSendLocation: (location: { latitude: number; longitude: number; address?: string }) => void;
}

const { width, height } = Dimensions.get('window');
const ASPECT_RATIO = width / height;
const LATITUDE_DELTA = 0.005; // Closer zoom for pinning
const LONGITUDE_DELTA = LATITUDE_DELTA * ASPECT_RATIO;
const LIVE_LOCATION_DURATION_MINUTES = 15;

export const LocationPicker = ({ visible, onClose, onSendLocation }: LocationPickerProps) => {
  const { theme, isDark } = useTheme();
  const [currentLocation, setCurrentLocation] = useState<Location.LocationObject | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const mapRef = useRef<MapViewRef>(null);
  const isMountedRef = useRef(true);
  const isVisibleRef = useRef(visible);
  const reverseGeocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const mapsApiKeyAvailable = hasGoogleMapsApiKey();

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (reverseGeocodeTimerRef.current) {
        clearTimeout(reverseGeocodeTimerRef.current);
      }
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
    }
  }, [visible]);

  useEffect(() => {
    if (visible) {
      void checkPermissionsAndGetLocation();
    }
  }, [visible]);

  const checkPermissionsAndGetLocation = async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (!isMountedRef.current || !isVisibleRef.current) {
        return;
      }

      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Permission to access location was denied');
        setPermissionGranted(false);
        setLoading(false);
        return;
      }

      setPermissionGranted(true);
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      if (!isMountedRef.current || !isVisibleRef.current) {
        return;
      }

      setCurrentLocation(location);
      setSelectedLocation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      });

      await fetchAddress(location.coords.latitude, location.coords.longitude);

    } catch (error) {
      console.error('Error getting location:', error);
      if (isMountedRef.current && isVisibleRef.current) {
        Alert.alert('Error', 'Could not fetch location');
      }
    } finally {
      if (isMountedRef.current && isVisibleRef.current) {
        setLoading(false);
      }
    }
  };

  const fetchAddress = async (latitude: number, longitude: number) => {
    try {
      const reverseGeocode = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });

      if (reverseGeocode.length > 0) {
        const addr = reverseGeocode[0];
        const addressString = [
          addr.name,
          addr.street,
          addr.city,
          addr.region,
          addr.country
        ].filter(Boolean).join(', ');
        if (isMountedRef.current && isVisibleRef.current) {
          setAddress(addressString);
        }
      }
    } catch (e) {
      console.log('Error reverse geocoding:', e);
      if (isMountedRef.current && isVisibleRef.current) {
        setAddress(`${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
      }
    }
  };

  const handleRegionChangeStart = () => {
    setIsDragging(true);
  };

  const handleRegionChangeComplete = (region: Region, details?: RegionChangeDetails) => {
    if (Platform.OS === 'android' && details && details.isGesture === false) {
      setIsDragging(false);
      return;
    }

    setIsDragging(false);
    setSelectedLocation({
      latitude: region.latitude,
      longitude: region.longitude,
    });

    if (reverseGeocodeTimerRef.current) {
      clearTimeout(reverseGeocodeTimerRef.current);
    }

    reverseGeocodeTimerRef.current = setTimeout(() => {
      void fetchAddress(region.latitude, region.longitude);
    }, Platform.OS === 'android' ? 300 : 120);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const geocoded = await Location.geocodeAsync(searchQuery);

      if (geocoded.length > 0) {
        const { latitude, longitude } = geocoded[0];
        const newRegion = {
          latitude,
          longitude,
          latitudeDelta: LATITUDE_DELTA,
          longitudeDelta: LONGITUDE_DELTA,
        };

        mapRef.current?.animateToRegion(newRegion, 1000);
        setSelectedLocation({ latitude, longitude });
        void fetchAddress(latitude, longitude);
      } else {
        Alert.alert('Not Found', 'Could not find location');
      }
    } catch (error) {
      console.error('Search error:', error);
      Alert.alert('Error', 'Failed to search location');
    } finally {
      setIsSearching(false);
    }
  };

  const handleSend = () => {
    if (selectedLocation) {
      setSending(true);
      onSendLocation({
        latitude: selectedLocation.latitude,
        longitude: selectedLocation.longitude,
        address: address || undefined,
      });
      setSending(false);
      handleClose();
    }
  };

  const handleClose = () => {
    if (reverseGeocodeTimerRef.current) {
      clearTimeout(reverseGeocodeTimerRef.current);
      reverseGeocodeTimerRef.current = null;
    }

    mapRef.current = null;
    onClose();
  };

  const goToCurrentLocation = () => {
    if (currentLocation && mapRef.current) {
      const latitude = currentLocation.coords.latitude;
      const longitude = currentLocation.coords.longitude;
      const newRegion = {
        latitude,
        longitude,
        latitudeDelta: LATITUDE_DELTA,
        longitudeDelta: LONGITUDE_DELTA,
      };
      mapRef.current.animateToRegion(newRegion, 1000);
      setSelectedLocation({ latitude, longitude });
      void fetchAddress(latitude, longitude);
    }
  };

  // Check if running in Expo Go (which doesn't support background location)
  const isExpoGo = Constants.appOwnership === 'expo';

  const handleLiveLocation = async () => {
    // Background location is not supported in Expo Go
    if (isExpoGo) {
      Alert.alert(
        'Development Build Required',
        'Live location sharing requires a development or production build. This feature is not available in Expo Go.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      // First ensure foreground permissions are granted
      const { status: foregroundStatus } = await Location.getForegroundPermissionsAsync();

      if (foregroundStatus !== 'granted') {
        // Need to request foreground permissions first
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Denied', 'Foreground location permission is required before enabling background location.');
          return;
        }
      }

      // Check background permissions
      const { status: backgroundStatus } = await Location.getBackgroundPermissionsAsync();

      if (backgroundStatus === 'granted') {
        // Permission already granted, proceed with live location logic
        Alert.alert('Coming Soon', 'Live location sharing will be available in the next update.');
        return;
      }

      // Request background permissions programmatically
      // On Android, this will show the "Allow all the time" option
      const { status: newBackgroundStatus } = await Location.requestBackgroundPermissionsAsync();

      if (newBackgroundStatus === 'granted') {
        // Permission granted, proceed with live location logic
        Alert.alert('Coming Soon', 'Live location sharing will be available in the next update.');
        return;
      }

      // If still not granted after request, guide user to settings
      // This handles cases where the user denied or the system requires manual settings change
      Alert.alert(
        'Background Location Required',
        'To share your live location, please select "Allow all the time" in location settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: async () => {
              if (Platform.OS === 'ios') {
                await Linking.openSettings();
              } else {
                const packageName = Constants.expoConfig?.android?.package || 'com.splitcircle.app';
                await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS, {
                  data: 'package:' + packageName
                });
              }
            }
          }
        ]
      );
    } catch (error) {
      console.error('Error requesting background permissions:', error);
      Alert.alert('Error', 'Could not request location permissions. If you are using Expo Go, please use a development build instead.');
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={handleClose}
      presentationStyle="pageSheet"
    >
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={theme.colors.onSurface} />
          </TouchableOpacity>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>Share Location</Text>
          <View style={{ width: 24 }} />
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={{ marginTop: 10, color: theme.colors.onSurface }}>Fetching location...</Text>
          </View>
        ) : !permissionGranted ? (
          <View style={styles.loadingContainer}>
            <Ionicons name="location-outline" size={48} color={theme.colors.error} />
            <Text style={{ marginTop: 10, color: theme.colors.onSurface }}>Location permission needed</Text>
            <Button mode="contained" onPress={checkPermissionsAndGetLocation} style={{ marginTop: 20 }}>
              Grant Permission
            </Button>
          </View>
        ) : (
          <>
            <View style={styles.searchContainer}>
              <View style={[styles.searchBar, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Ionicons name="search" size={20} color={theme.colors.onSurfaceVariant} style={{ marginLeft: 10 }} />
                <TextInput
                  style={[styles.searchInput, { color: theme.colors.onSurface }]}
                  placeholder="Search for a place..."
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  onSubmitEditing={handleSearch}
                  returnKeyType="search"
                />
                {isSearching && <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginRight: 10 }} />}
                {searchQuery.length > 0 && !isSearching && (
                  <TouchableOpacity onPress={() => setSearchQuery('')}>
                    <Ionicons name="close-circle" size={20} color={theme.colors.onSurfaceVariant} style={{ marginRight: 10 }} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <View style={styles.mapContainer}>
              {currentLocation && (
                mapsApiKeyAvailable ? (
                  <MapErrorBoundary fallback={
                    <View style={[styles.map, styles.mapLoading, { backgroundColor: isDark ? 'rgba(30,30,40,0.95)' : 'rgba(245,245,250,0.95)' }]}>
                      <Ionicons name="location" size={50} color={theme.colors.primary} />
                      <Text style={{ marginTop: 12, color: theme.colors.onSurface }}>Map unavailable right now</Text>
                    </View>
                  }>
                    <React.Suspense fallback={
                      <View style={[styles.map, styles.mapLoading]}>
                        <ActivityIndicator size="large" color={theme.colors.primary} />
                        <Text style={{ marginTop: 10, color: theme.colors.onSurface }}>Loading map...</Text>
                      </View>
                    }>
                      <MapView
                        ref={(instance) => {
                          mapRef.current = instance as MapViewRef | null;
                        }}
                        style={styles.map}
                        initialRegion={{
                          latitude: currentLocation.coords.latitude,
                          longitude: currentLocation.coords.longitude,
                          latitudeDelta: LATITUDE_DELTA,
                          longitudeDelta: LONGITUDE_DELTA,
                        }}
                        showsUserLocation
                        showsMyLocationButton={false}
                        showsPointsOfInterests={false}
                        toolbarEnabled={false}
                        moveOnMarkerPress={false}
                        onRegionChange={handleRegionChangeStart}
                        onRegionChangeComplete={handleRegionChangeComplete}
                      />
                    </React.Suspense>
                  </MapErrorBoundary>
                ) : (
                  // Fallback UI when Maps API key is not configured
                  <View style={[styles.map, styles.mapLoading, { backgroundColor: isDark ? 'rgba(30,30,40,0.95)' : 'rgba(245,245,250,0.95)' }]}>
                    <Ionicons name="location" size={60} color={theme.colors.primary} />
                    <Text style={{ marginTop: 16, color: theme.colors.onSurface, fontSize: 16, fontWeight: '600' }}>GPS Location</Text>
                    <Text style={{ marginTop: 8, color: theme.colors.onSurfaceVariant, fontSize: 13, textAlign: 'center', paddingHorizontal: 32 }}>
                      Map preview unavailable, but you can still share your current location
                    </Text>
                    <TouchableOpacity
                      style={{ marginTop: 20, flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.primaryContainer, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 }}
                      onPress={goToCurrentLocation}
                    >
                      <Ionicons name="locate" size={18} color={theme.colors.primary} />
                      <Text style={{ marginLeft: 8, color: theme.colors.primary, fontWeight: '500' }}>Refresh Location</Text>
                    </TouchableOpacity>
                  </View>
                )
              )}

              {/* Center Pin - only show when map is available */}
              {mapsApiKeyAvailable && (
                <View style={styles.centerPinContainer} pointerEvents="none">
                  <Ionicons name="location" size={40} color={theme.colors.primary} style={styles.centerPinIcon} />
                </View>
              )}

              {/* My Location Button - only show when map is available */}
              {mapsApiKeyAvailable && (
                <TouchableOpacity
                  style={[styles.myLocationButton, { backgroundColor: theme.colors.surface }]}
                  onPress={goToCurrentLocation}
                >
                  <Ionicons name="locate" size={24} color={theme.colors.primary} />
                </TouchableOpacity>
              )}
            </View>

            <View style={[styles.footer, { backgroundColor: theme.colors.surface }]}>
              <View style={styles.locationInfo}>
                <Ionicons name="location" size={24} color={theme.colors.primary} />
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
                    {isDragging ? 'Locating...' : 'Selected Location'}
                  </Text>
                  <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                    {isDragging ? '...' : (address || `${selectedLocation?.latitude.toFixed(6)}, ${selectedLocation?.longitude.toFixed(6)}`)}
                  </Text>
                </View>
              </View>

              <Button
                mode="contained"
                onPress={handleSend}
                loading={sending}
                disabled={isDragging || !selectedLocation}
                style={styles.sendButton}
                buttonColor={theme.colors.primary}
              >
                Share This Location
              </Button>

              <Button
                mode="outlined"
                onPress={handleLiveLocation}
                style={[styles.sendButton, { marginTop: 10, borderColor: theme.colors.primary }]}
                textColor={theme.colors.primary}
                icon="clock-outline"
              >
                Share Live Location ({LIVE_LOCATION_DURATION_MINUTES} min)
              </Button>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  closeButton: {
    padding: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchContainer: {
    position: 'absolute',
    top: 70,
    left: 16,
    right: 16,
    zIndex: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 25,
    height: 50,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  searchInput: {
    flex: 1,
    height: 50,
    paddingHorizontal: 10,
    fontSize: 16,
  },
  mapContainer: {
    flex: 1,
    position: 'relative',
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  mapLoading: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  centerPinContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  centerPinIcon: {
    transform: [{ translateY: -20 }],
  },
  myLocationButton: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  footer: {
    padding: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: -2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  locationInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sendButton: {
    borderRadius: 8,
  },
});
