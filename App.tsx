import React from 'react';
import { View, Text, StyleSheet, StatusBar } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <Text style={styles.title}>Welcome to SplitCircle!</Text>
      <Text style={styles.subtitle}>Your expense splitting app</Text>
      <Text style={styles.info}>🎉 App is running successfully in Expo Go</Text>
      <Text style={styles.note}>Firebase Auth configured ✓</Text>
      <Text style={styles.note}>Ready for development ✓</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#2196F3',
  },
  subtitle: {
    fontSize: 18,
    color: '#666',
    marginBottom: 30,
  },
  info: {
    fontSize: 16,
    marginTop: 20,
    color: '#4CAF50',
  },
  note: {
    fontSize: 14,
    marginTop: 10,
    color: '#999',
  },
});
