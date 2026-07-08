// Shared fallback for routes that need a group synced locally. Deep links
// (expense / settlement / group-join notifications) land here before
// Firestore syncs; normally the group arrives moments later. If it never
// does (deleted group, stale notification), time out into a "Group not
// found" state with a way back instead of stranding the user.

import { ROUTES } from '@/constants';
import { LoadingScreen } from '@/screens/onboarding/LoadingScreen';

export const GroupLoadingFallback = ({ navigation }: any) => (
  <LoadingScreen
    timeoutMs={10000}
    timeoutIcon="account-group-outline"
    timeoutTitle="Group not found"
    timeoutHint="This group may have been deleted or isn't available on this device."
    timeoutActionLabel="Go back"
    onTimeoutAction={() => {
      if (typeof navigation?.canGoBack === 'function' && navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
      navigation?.navigate(ROUTES.APP.ROOT, { screen: ROUTES.APP.GROUPS_TAB });
    }}
  />
);
