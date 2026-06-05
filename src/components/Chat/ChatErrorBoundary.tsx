import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface ChatErrorBoundaryProps {
  onGoBack?: () => void;
  children: React.ReactNode;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
}

export class ChatErrorBoundary extends React.Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  state: ChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ChatErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error('ChatErrorBoundary caught:', error.message);
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text variant="titleMedium" style={styles.title}>Something went wrong</Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            This chat encountered an error. You can try again or go back.
          </Text>
          <View style={styles.actions}>
            <Button mode="contained" onPress={this.handleRetry} style={styles.button}>
              Try Again
            </Button>
            {this.props.onGoBack && (
              <Button mode="outlined" onPress={this.props.onGoBack} style={styles.button}>
                Go Back
              </Button>
            )}
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  title: {
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    marginBottom: 24,
    textAlign: 'center',
    opacity: 0.7,
  },
  actions: {
    gap: 12,
  },
  button: {
    minWidth: 140,
  },
});

export default ChatErrorBoundary;
