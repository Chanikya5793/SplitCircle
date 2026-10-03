import { NavigationContext } from '@react-navigation/native';
import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, InteractionManager } from 'react-native';

const subscribeAppState = (notify: () => void) => {
  const subscription = AppState.addEventListener('change', notify);
  return () => subscription.remove();
};
const isAppActive = () => AppState.currentState === 'active';
const inactiveOnServer = () => false;

export const useAmbientMotion = (reduceMotion: boolean): boolean => {
  // Startup and authentication backgrounds can live outside a navigator.
  const navigation = useContext(NavigationContext);
  const subscribeFocus = useCallback((notify: () => void) => {
    const offFocus = navigation?.addListener('focus', notify);
    const offBlur = navigation?.addListener('blur', notify);
    return () => {
      offFocus?.();
      offBlur?.();
    };
  }, [navigation]);
  const getFocus = useCallback(() => navigation?.isFocused() ?? true, [navigation]);
  const focused = useSyncExternalStore(subscribeFocus, getFocus, getFocus);
  const active = useSyncExternalStore(subscribeAppState, isAppActive, inactiveOnServer);
  const permitted = !reduceMotion && focused && active;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!permitted) return;

    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [permitted]);

  return permitted && ready;
};
