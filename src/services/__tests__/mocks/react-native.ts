/**
 * Minimal react-native mock for service unit tests (vitest.services.config.ts
 * aliases 'react-native' here). Platform.OS is 'ios' so nativeCallService
 * loads its CallKeep code paths.
 */
export const Platform = {
  OS: 'ios' as string,
  select: <T>(options: { ios?: T; android?: T; default?: T }): T | undefined =>
    options.ios ?? options.default,
};

export default { Platform };
