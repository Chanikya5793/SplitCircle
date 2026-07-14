/**
 * navigationRef.ts — the app-wide NavigationContainer ref, in its own module so
 * both AppNavigator (which owns the container) and deepLinkService (which drives
 * programmatic navigation from Siri/App-Intent/widget deep links) can import it
 * without a circular dependency.
 */

import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef<any>();
