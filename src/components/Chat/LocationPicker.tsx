import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, Linking, Modal, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { Button, Text } from 'react-native-paper';

interface LocationPickerProps {
  visible: boolean;
  onClose: () => void;
  onSendLocation: (location: { latitude: number; longitude: number; address?: string }) => void;
}

const { width, height } = Dimensions.get('window');
const ASPECT_RATIO = width / height;
const LATITUDE_DELTA = 0.01; // Zoom level
const LONGITUDE_DELTA = LATITUDE_DELTA * ASPECT_RATIO;

export const LocationPicker = ({ visible, onClose, onSendLocation }: LocationPickerProps) => {
  const { theme, isDark } = useTheme();
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);

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
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      setLocation(currentLocation);
      
      // Reverse geocode to get address
      try {
        const reverseGeocode = await Location.reverseGeocodeAsync({
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude,
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
      }
      
    } catch (error) {
      console.error('Error getting location:', error);
      Alert.alert('Error', 'Could not fetch location');
    } finally {
      setLoading(false);
    }
  };

  const handleSend = () => {
    if (location) {
      setSending(true);
      onSendLocation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        address: address || undefined,
      });
      setSending(false);
      onClose();
    }
  };

  const handleLiveLocation = async () => {
    try {
      // Check background permissions
      const { status: backgroundStatus } = await Location.getBackgroundPermissionsAsync();
      
      if (backgroundStatus === 'granted') {
        // Permission already granted, proceed with live location logic
        Alert.alert('Coming Soon', 'Live location sharing will be available in the next update.');
        return;
      }

      // If not granted, we need to ask or guide user
      Alert.alert(
        'Background Location Required',
        'To share your live location, you need to allow "Always" location access in settings.',
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
      console.error('Error checking background permissions:', error);
      Alert.alert('Error', 'Could not check location permissions');
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
            <View style={styles.mapContainer}>
              {location && (
                <MapView
                  provider={PROVIDER_DEFAULT}
                  style={styles.map}
                  initialRegion={{
                    latitude: location.coords.latitude,
                    longitude: location.coords.longitude,
                    latitudeDelta: LATITUDE_DELTA,
                    longitudeDelta: LONGITUDE_DELTA,
                  }}
                  showsUserLocation
                  showsMyLocationButton
                >
                  <Marker
                    coordinate={{
                      latitude: location.coords.latitude,
                      longitude: location.coords.longitude,
                    }}
                    title="Current Location"
                    description={address || ''}
                  />
                </MapView>
              )}
            </View>

            <View style={[styles.footer, { backgroundColor: theme.colors.surface }]}>
              <View style={styles.locationInfo}>
                <Ionicons name="location" size={24} color={theme.colors.primary} />
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>Current Location</Text>
                  <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                    {address || `${location?.coords.latitude.toFixed(6)}, ${location?.coords.longitude.toFixed(6)}`}
                  </Text>
                </View>
              </View>
              
              <Button 
                mode="contained" 
                onPress={handleSend} 
                loading={sending}
                style={styles.sendButton}
                buttonColor={theme.colors.primary}
              >
                Share Current Location
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
  mapContainer: {
    flex: 1,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
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
