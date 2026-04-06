import { useIsFocused, useNavigation } from '@react-navigation/native';
import { useLayoutEffect } from 'react';

const getTopmostParent = (navigation: any) => {
  let parent = navigation?.getParent?.();
  let topmostParent = null;

  while (parent) {
    topmostParent = parent;
    parent = parent.getParent?.();
  }

  return topmostParent;
};

export const useSyncRootStackTitle = (title: string | undefined) => {
  const navigation = useNavigation<any>();
  const isFocused = useIsFocused();

  useLayoutEffect(() => {
    if (!isFocused || !title) {
      return;
    }

    const rootStack = getTopmostParent(navigation);
    rootStack?.setOptions({ title });
  }, [isFocused, navigation, title]);
};
