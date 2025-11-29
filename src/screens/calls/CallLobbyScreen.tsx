import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useChat } from '@/context/ChatContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useRef } from 'react';
import { Animated, FlatList, StyleSheet, View } from 'react-native';
import { Button, List, Text } from 'react-native-paper';

interface CallLobbyScreenProps {
  onStartCall: (thread: ChatThread, type: 'audio' | 'video') => void;
}

export const CallLobbyScreen = ({ onStartCall }: CallLobbyScreenProps) => {
  const navigation = useNavigation();
  const { threads } = useChat();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={[styles.stickyHeaderGlass, { backgroundColor: isDark ? 'rgba(30, 30, 30, 0.8)' : 'rgba(255, 255, 255, 0.8)' }]}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Calls</Text>
        </GlassView>
      </Animated.View>

      <View style={styles.container}>
        <FlatList
          data={threads}
          keyExtractor={(item) => item.chatId}
          contentContainerStyle={[styles.listContent, { paddingTop: 60, paddingBottom: 100 }]}
          ListHeaderComponent={
            <View style={styles.headerContainer}>
              <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Calls</Text>
            </View>
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: false }
          )}
          scrollEventThrottle={16}
          renderItem={({ item }) => (
            <GlassView style={styles.card}>
              <List.Item
                title={item.participants.map((p) => p.displayName).join(', ')}
                description={item.lastMessage?.content ?? 'Start a call'}
                titleStyle={{ color: theme.colors.onSurface }}
                descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                right={() => (
                  <View style={styles.callActions}>
                    <Button compact mode="text" onPress={() => onStartCall(item, 'audio')}>
                      Audio
                    </Button>
                    <Button compact mode="text" onPress={() => onStartCall(item, 'video')}>
                      Video
                    </Button>
                  </View>
                )}
              />
            </GlassView>
          )}
          ListEmptyComponent={<Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No chats available for calls.</Text>}
        />
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  callActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  empty: {
    marginTop: 32,
    textAlign: 'center',
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
  },
});
