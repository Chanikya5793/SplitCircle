import React from 'react';

interface MapErrorBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface MapErrorBoundaryState {
  hasError: boolean;
}

export class MapErrorBoundary extends React.Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  state: MapErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MapErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.warn('MapErrorBoundary caught:', error.message);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

export default MapErrorBoundary;
