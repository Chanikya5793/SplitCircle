import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export const useReduceMotion = () => {
  // Start conservatively so Reduce Motion users never see a flash of animation
  // while the native preference is being resolved.
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let mounted = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
};
