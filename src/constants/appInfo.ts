import Constants from 'expo-constants';

/** Single source of truth for the user-facing app name. Reads the Expo config
 *  (`name` in app.config.ts) so in-app copy always matches the installed app,
 *  killing the ManaSplit/SplitCircle/"SC" drift across screens. */
export const APP_NAME: string = Constants.expoConfig?.name ?? 'SplitCircle';

/** Marketing version from the build (e.g. "0.0.5"). */
export const APP_VERSION: string = Constants.expoConfig?.version ?? '';
