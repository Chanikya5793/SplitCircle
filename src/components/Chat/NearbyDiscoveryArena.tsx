import { useReduceMotion } from '@/components/brand/useReduceMotion';
import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type {
  NearbyMessagingSnapshot,
  NearbyPeerPresentation,
} from '@/services/nearbyMessagingState';
import { getNearbyPeerPresentations } from '@/services/nearbyMessagingState';
import { testNearbyPeerConnection } from '@/services/nearbyMessageService';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';

interface NearbyDiscoveryArenaProps {
  active: boolean;
  snapshot: NearbyMessagingSnapshot;
  selectedDeviceId?: string;
  onSelectDevice: (deviceId: string) => void;
  onScanAgain: () => void;
}

const headlineFor = (
  snapshot: NearbyMessagingSnapshot,
  peerCount: number,
): { title: string; detail: string } => {
  if (snapshot.status === 'error') {
    return {
      title: 'Discovery needs attention',
      detail: 'Check the requirements below, then scan again.',
    };
  }
  if (snapshot.connectedPeerCount > 0) {
    return {
      title: 'Known contact connected',
      detail: `${snapshot.connectedPeerCount} recognized ${snapshot.connectedPeerCount === 1 ? 'phone is' : 'phones are'} ready. Every message is verified separately.`,
    };
  }
  if (snapshot.connectingPeerCount > 0) {
    return {
      title: 'Securing the connection…',
      detail: 'The phones found each other. Keep both apps open.',
    };
  }
  if (peerCount > 0) {
    return {
      title: 'Known phone found',
      detail: 'Checking the cached conversation trust before connecting.',
    };
  }
  return {
    title: 'Looking for known contacts…',
    detail: snapshot.ignoredPeerCount > 0
      ? `${snapshot.ignoredPeerCount} unknown ${snapshot.ignoredPeerCount === 1 ? 'phone was' : 'phones were'} ignored.`
      : 'Unknown ManaSplit installations cannot connect.',
  };
};

const statusIcon = (
  peer: NearbyPeerPresentation,
): React.ComponentProps<typeof Ionicons>['name'] => {
  if (peer.status === 'connected') return 'checkmark-circle';
  if (peer.status === 'connecting') return 'lock-closed';
  return 'phone-portrait-outline';
};

export const NearbyDiscoveryArena = ({
  active,
  snapshot,
  selectedDeviceId,
  onSelectDevice,
  onScanAgain,
}: NearbyDiscoveryArenaProps) => {
  const { theme } = useTheme();
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  const peers = useMemo(() => getNearbyPeerPresentations(snapshot), [snapshot]);
  const selectedPeer = peers.find((peer) => peer.deviceId === selectedDeviceId)
    ?? peers[0];
  const headline = headlineFor(snapshot, peers.length);

  useEffect(() => {
    pulse.stopAnimation();
    if (!active || reduceMotion || snapshot.status === 'connected') {
      pulse.setValue(snapshot.status === 'connected' ? 0.55 : 0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2_200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    pulse.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [active, pulse, reduceMotion, snapshot.status]);

  const renderRing = (offset: number) => {
    const progress = Animated.modulo(Animated.add(pulse, offset), 1);
    return (
      <Animated.View
        pointerEvents="none"
        style={[
          styles.scanRing,
          {
            borderColor: snapshot.status === 'connected'
              ? theme.colors.success
              : theme.colors.primary,
            opacity: progress.interpolate({
              inputRange: [0, 0.7, 1],
              outputRange: [0.42, 0.16, 0],
            }),
            transform: [{
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0.62, 1.48],
              }),
            }],
          },
        ]}
      />
    );
  };

  const selectPeer = (deviceId: string) => {
    lightHaptic();
    onSelectDevice(deviceId);
  };

  const runProbe = (peer: NearbyPeerPresentation) => {
    lightHaptic();
    onSelectDevice(peer.deviceId);
    testNearbyPeerConnection(peer.deviceId);
  };

  return (
    <View>
      <View
        style={styles.radar}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={headline.title}
        accessibilityValue={{ text: headline.detail }}
      >
        {renderRing(0)}
        {renderRing(0.34)}
        {renderRing(0.68)}
        <View
          style={[
            styles.radarCore,
            {
              backgroundColor: snapshot.status === 'connected'
                ? theme.colors.successContainer
                : theme.colors.primaryContainer,
            },
          ]}
        >
          <Ionicons
            name={snapshot.status === 'connected' ? 'checkmark' : 'radio-outline'}
            size={34}
            color={snapshot.status === 'connected' ? theme.colors.success : theme.colors.primary}
          />
        </View>
      </View>

      <Text style={[styles.headline, { color: theme.colors.onSurface }]}>
        {headline.title}
      </Text>
      <Text style={[styles.headlineDetail, { color: theme.colors.onSurfaceVariant }]}>
        {headline.detail}
      </Text>

      {peers.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.peerRail}
          accessibilityRole="list"
        >
          {peers.map((peer) => {
            const selected = peer.deviceId === selectedPeer?.deviceId;
            const connected = peer.status === 'connected';
            return (
              <Pressable
                key={peer.deviceId}
                onPress={() => selectPeer(peer.deviceId)}
                accessibilityRole="button"
                accessibilityLabel={`${peer.label}, ${peer.statusLabel}`}
                accessibilityHint="Shows connection details for this phone"
                accessibilityState={{ selected }}
                style={styles.peerPressable}
              >
                <GlassCard
                  radius="lg"
                  style={[
                    styles.peerCard,
                    selected && { borderColor: theme.colors.primary },
                  ]}
                  contentStyle={styles.peerCardContent}
                >
                  <View
                    style={[
                      styles.peerIcon,
                      {
                        backgroundColor: connected
                          ? theme.colors.successContainer
                          : theme.colors.primaryContainer,
                      },
                    ]}
                  >
                    <Ionicons
                      name={statusIcon(peer)}
                      size={26}
                      color={connected ? theme.colors.success : theme.colors.primary}
                    />
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[styles.peerLabel, { color: theme.colors.onSurface }]}
                  >
                    {peer.label}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.peerStatus,
                      { color: connected ? theme.colors.success : theme.colors.primary },
                    ]}
                  >
                    {peer.statusLabel}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[styles.peerDetail, { color: theme.colors.onSurfaceVariant }]}
                  >
                    {peer.detail}
                  </Text>
                  {selected && (
                    <View style={[styles.selectedMark, { backgroundColor: theme.colors.primary }]}>
                      <Ionicons name="checkmark" size={11} color={theme.colors.onPrimary} />
                    </View>
                  )}
                </GlassCard>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <GlassCard radius="lg" contentStyle={styles.emptyCard}>
          <Ionicons name="phone-portrait-outline" size={22} color={theme.colors.onSurfaceVariant} />
          <View style={styles.emptyCopy}>
            <Text style={[styles.emptyTitle, { color: theme.colors.onSurface }]}>
              No phones visible yet
            </Text>
            <Text style={[styles.emptyDetail, { color: theme.colors.onSurfaceVariant }]}>
              Open this screen on the other iPhone and keep it nearby.
            </Text>
          </View>
        </GlassCard>
      )}

      {selectedPeer && (
        <GlassCard radius="lg" contentStyle={styles.detailsCard}>
          <View style={styles.detailsHeader}>
            <View style={styles.detailsTitleWrap}>
              <Text style={[styles.detailsTitle, { color: theme.colors.onSurface }]}>
                {selectedPeer.label}
              </Text>
              <Text style={[styles.detailsSubtitle, { color: theme.colors.onSurfaceVariant }]}>
                Profile name resolved privately on this phone
              </Text>
            </View>
            <View
              style={[
                styles.statePill,
                {
                  backgroundColor: selectedPeer.status === 'connected'
                    ? theme.colors.successContainer
                    : theme.colors.primaryContainer,
                },
              ]}
            >
              <Text
                style={[
                  styles.statePillText,
                  {
                    color: selectedPeer.status === 'connected'
                      ? theme.colors.success
                      : theme.colors.primary,
                  },
                ]}
              >
                {selectedPeer.statusLabel}
              </Text>
            </View>
          </View>

          <View style={styles.factRow}>
            <Ionicons name="wifi-outline" size={17} color={theme.colors.onSurfaceVariant} />
            <Text style={[styles.factLabel, { color: theme.colors.onSurfaceVariant }]}>
              Transport
            </Text>
            <Text style={[styles.factValue, { color: theme.colors.onSurface }]}>
              Peer-to-peer Wi-Fi
            </Text>
          </View>
          <View style={styles.factRow}>
            <Ionicons name="shield-checkmark-outline" size={17} color={theme.colors.onSurfaceVariant} />
            <Text style={[styles.factLabel, { color: theme.colors.onSurfaceVariant }]}>
              Trust
            </Text>
            <Text style={[styles.factValue, { color: theme.colors.onSurface }]}>
              Cached identity · each message signed
            </Text>
          </View>
          <View style={styles.factRow}>
            <Ionicons name="lock-closed-outline" size={17} color={theme.colors.onSurfaceVariant} />
            <Text style={[styles.factLabel, { color: theme.colors.onSurfaceVariant }]}>
              Encryption
            </Text>
            <Text style={[styles.factValue, { color: theme.colors.onSurface }]}>
              End-to-end · one copy per device
            </Text>
          </View>
          <View style={styles.factRow}>
            <Ionicons name="pulse-outline" size={17} color={theme.colors.onSurfaceVariant} />
            <Text style={[styles.factLabel, { color: theme.colors.onSurfaceVariant }]}>
              Link test
            </Text>
            <Text style={[styles.factValue, { color: theme.colors.onSurface }]}>
              {selectedPeer.isProbing
                ? 'Testing…'
                : selectedPeer.latencyMs === undefined
                  ? 'Not tested'
                  : `${selectedPeer.latencyMs} ms`}
            </Text>
          </View>

          <Pressable
            onPress={() => selectedPeer.status === 'connected'
              ? runProbe(selectedPeer)
              : onScanAgain()}
            disabled={selectedPeer.isProbing}
            accessibilityRole="button"
            accessibilityLabel={selectedPeer.status === 'connected'
              ? `Test link to ${selectedPeer.label}`
              : 'Scan for nearby phones again'}
            style={[
              styles.testButton,
              { backgroundColor: theme.colors.primary },
              selectedPeer.isProbing && styles.testButtonDisabled,
            ]}
          >
            {selectedPeer.isProbing ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Ionicons
                name={selectedPeer.status === 'connected' ? 'pulse' : 'refresh'}
                size={17}
                color={theme.colors.onPrimary}
              />
            )}
            <Text style={[styles.testButtonText, { color: theme.colors.onPrimary }]}>
              {selectedPeer.isProbing
                ? 'Testing link…'
                : selectedPeer.status === 'connected'
                  ? 'Test link'
                  : 'Scan again'}
            </Text>
          </Pressable>
        </GlassCard>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  radar: {
    height: 154,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  scanRing: {
    position: 'absolute',
    width: 118,
    height: 118,
    borderRadius: 59,
    borderWidth: 1.5,
  },
  radarCore: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    textAlign: 'center',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
  },
  headlineDetail: {
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    paddingHorizontal: 18,
  },
  peerRail: {
    gap: 10,
    paddingHorizontal: 2,
    paddingVertical: 16,
  },
  peerPressable: {
    width: 154,
  },
  peerCard: {
    minHeight: 174,
  },
  peerCardContent: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  peerIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 9,
  },
  peerLabel: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  peerStatus: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    marginTop: 2,
  },
  peerDetail: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
  },
  selectedMark: {
    position: 'absolute',
    top: 9,
    right: 9,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginTop: 16,
    marginBottom: 14,
  },
  emptyCopy: {
    flex: 1,
    marginLeft: 11,
  },
  emptyTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  emptyDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  detailsCard: {
    padding: 14,
    marginBottom: 14,
  },
  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 11,
  },
  detailsTitleWrap: {
    flex: 1,
  },
  detailsTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  detailsSubtitle: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
  },
  statePill: {
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  statePillText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.45,
  },
  factRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
  },
  factLabel: {
    width: 74,
    marginLeft: 7,
    fontSize: 12,
    lineHeight: 16,
  },
  factValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  testButton: {
    minHeight: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    marginTop: 11,
  },
  testButtonDisabled: {
    opacity: 0.68,
  },
  testButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
});

export default NearbyDiscoveryArena;
