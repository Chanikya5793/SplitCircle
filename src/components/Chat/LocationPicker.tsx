import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, Linking, Modal, Platform, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import MapView, { PROVIDER_DEFAULT, Region } from 'react-native-maps';
import { Button, Text } from 'react-native-paper';

interface LocationPickerProps {
  visible: boolean;
  onClose: () => void;
  onSendLocation: (location: { latitude: number; longitude: number; address?: string }) => void;
}

const { width, height } = Dimensions.get('window');
const ASPECT_RATIO = width / height;
const LATITUDE_DELTA = 0.005; // Closer zoom for pinning
const LONGITUDE_DELTA = LATITUDE_DELTA * ASPECT_RATIO;

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
  const mapRef = useRef<MapView>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (visible) {
      checkPermissionsAndGetLocation();
    }
  }, [visible]);

  const checkPermissionsAndGetLocation = async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
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
      
      setCurrentLocation(location);
      setSelectedLocation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      });
      
      await fetchAddress(location.coords.latitude, location.coords.longitude);
      
    } catch (error) {
      console.error('Error getting location:', error);
      Alert.alert('Error', 'Could not fetch location');
    } finally {
      setLoading(false);
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
        setAddress(addressString);
      }
    } catch (e) {
      console.log('Error reverse geocoding:', e);
      setAddress(`${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
    }
  };

  const handleRegionChange = () => {
    setIsDragging(true);
  };

  const handleRegionChangeComplete = async (region: Region) => {
    setIsDragging(false);
    setSelectedLocation({
      latitude: region.latitude,
      longitude: region.longitude,
    });
    await fetchAddress(region.latitude, region.longitude);
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
        // Address will be updated by onRegionChangeComplete
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
      onClose();
    }
  };

  const goToCurrentLocation = () => {
    if (currentLocation && mapRef.current) {
      const newRegion = {
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
        latitudeDelta: LATITUDE_DELTA,
        longitudeDelta: LONGITUDE_DELTA,
      };
      mapRef.current.animateToRegion(newRegion, 1000);
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
                await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS, {
                  data: 'package:' + 'com.splitcircle.app' // Ensure this matches your package name
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
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
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
                <MapView
                  ref={mapRef}
                  provider={PROVIDER_DEFAULT}
                  style={styles.map}
                  initialRegion={{
                    latitude: currentLocation.coords.latitude,
                    longitude: currentLocation.coords.longitude,
                    latitudeDelta: LATITUDE_DELTA,
                    longitudeDelta: LONGITUDE_DELTA,
                  }}
                  showsUserLocation
                  showsMyLocationButton={false}
                  onRegionChange={handleRegionChange}
                  onRegionChangeComplete={handleRegionChangeComplete}
                />
              )}
              
              {/* Center Pin */}
              <View style={styles.centerPinContainer} pointerEvents="none">
                <Ionicons name="location" size={40} color={theme.colors.primary} style={{ marginBottom: 40 }} />
              </View>

              {/* My Location Button */}
              <TouchableOpacity 
                style={[styles.myLocationButton, { backgroundColor: theme.colors.surface }]}
                onPress={goToCurrentLocation}
              >
                <Ionicons name="locate" size={24} color={theme.colors.primary} />
              </TouchableOpacity>
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
                Share Live Location (15 min)
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
  centerPinContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
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
