import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';

interface LiquidBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export const LiquidBackground = ({ children, style }: LiquidBackgroundProps) => {
  return (
    <View style={[styles.container, style]}>
      <LinearGradient
        colors={['#fdfbfb', '#ebedee']}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.blob, styles.blob1]} />
      <View style={[styles.blob, styles.blob2]} />
      <View style={[styles.blob, styles.blob3]} />
      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fdfbfb',
  },
  content: {
    flex: 1,
    zIndex: 1,
  },
  blob: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.6,
  },
  blob1: {
    width: 300,
    height: 300,
    backgroundColor: '#ff9a9e',
    top: -100,
    left: -100,
  },
  blob2: {
    width: 300,
    height: 300,
    backgroundColor: '#fad0c4',
    bottom: -100,
    right: -100,
  },
  blob3: {
    width: 200,
    height: 200,
    backgroundColor: '#a18cd1',
    top: '40%',
    left: -100,
    opacity: 0.4,
  },
});
