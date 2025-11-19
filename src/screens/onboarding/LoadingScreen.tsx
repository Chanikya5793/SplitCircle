import { colors } from '@/constants';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

export const LoadingScreen = () => (
  <View style={styles.container}>
    <ActivityIndicator animating size="large" color={colors.primary} />
    <Text style={styles.text}>Preparing SplitCircle…</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  text: {
    color: colors.muted,
  },
});
