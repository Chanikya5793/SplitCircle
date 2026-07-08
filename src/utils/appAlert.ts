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
 * Drop-in replacement for Alert.alert that actually works on web.
 *
 * Native: delegates to Alert.alert untouched.
 * Web: renders a themed react-native-paper Dialog via AppAlertHost
 * (RN-web's Alert.alert with buttons is a silent no-op).
 */
export function appAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
): void {
  if (Platform.OS !== 'web') {
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
