import { Alert, Platform } from 'react-native';
import type { AlertButton, AlertOptions } from 'react-native';

export interface AppAlertRequest {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
}

type AlertListener = (request: AppAlertRequest) => void;

let listener: AlertListener | null = null;
let nextId = 1;
const queue: AppAlertRequest[] = [];

/**
 * Registered by AppAlertHost (web only). Returns an unsubscribe function.
 * Any alerts fired before the host mounts are flushed on registration.
 */
export function registerAppAlertHost(next: AlertListener): () => void {
  listener = next;
  while (queue.length > 0) {
    const pending = queue.shift();
    if (pending) next(pending);
  }
  return () => {
    if (listener === next) listener = null;
  };
}

/**
 * Drop-in replacement for Alert.alert that actually works on web — and on
 * Android for menus with more than three options.
 *
 * Web: renders a themed react-native-paper Dialog via AppAlertHost
 * (RN-web's Alert.alert with buttons is a silent no-op).
 *
 * ANDROID + >3 BUTTONS: also routed to AppAlertHost. Android's AlertDialog
 * has exactly three button slots (positive / negative / neutral), so RN
 * silently DROPS every button past the third. The long-press quick-action
 * menus pass five (e.g. Add expense / Settle up / Stats / Archive / Cancel),
 * so "Cancel" — the last one — never rendered, leaving the menu with no
 * visible way out. AppAlertHost has no such limit and is already mounted
 * app-wide in App.tsx, so the fix is to stop gating it to web.
 *
 * iOS is untouched: its action sheets take any number of buttons.
 */
export function appAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
): void {
  const overAndroidButtonLimit = Platform.OS === 'android' && (buttons?.length ?? 0) > 3;
  if (Platform.OS !== 'web' && !overAndroidButtonLimit) {
    Alert.alert(title, message, buttons, options);
    return;
  }

  const resolvedButtons: AlertButton[] =
    buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];

  const request: AppAlertRequest = {
    id: nextId++,
    title,
    message,
    buttons: resolvedButtons,
    options,
  };

  if (listener) {
    listener(request);
  } else {
    queue.push(request);
  }
}

/**
 * Drop-in replacement for Alert.prompt (iOS-only API) that also works on web.
 *
 * Native: delegates to Alert.prompt.
 * Web: uses window.prompt and routes the result through the same callback shape.
 */
export function appPrompt(
  title: string,
  message?: string,
  callbackOrButtons?: ((text: string) => void) | AlertButton[],
  type?: 'default' | 'plain-text' | 'secure-text' | 'login-password',
  defaultValue?: string,
): void {
  if (Platform.OS !== 'web') {
    Alert.prompt(title, message, callbackOrButtons, type, defaultValue);
    return;
  }

  const promptText = message ? `${title}\n\n${message}` : title;
  // eslint-disable-next-line no-alert
  const result = window.prompt(promptText, defaultValue ?? '');

  if (typeof callbackOrButtons === 'function') {
    if (result !== null) callbackOrButtons(result);
    return;
  }

  if (Array.isArray(callbackOrButtons)) {
    if (result === null) {
      const cancel = callbackOrButtons.find((button) => button.style === 'cancel');
      cancel?.onPress?.();
      return;
    }
    const confirm =
      callbackOrButtons.find((button) => button.style !== 'cancel') ??
      callbackOrButtons[callbackOrButtons.length - 1];
    (confirm?.onPress as ((text?: string) => void) | undefined)?.(result);
  }
}
