import { registerAppAlertHost, type AppAlertRequest } from '@/utils/appAlert';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Button, Dialog, Portal, Text } from 'react-native-paper';
import type { AlertButton } from 'react-native';

/**
 * Web-only host that renders appAlert() requests as themed Paper dialogs.
 * On native this renders nothing (appAlert delegates to Alert.alert there).
 */
export function AppAlertHost() {
  const [pending, setPending] = useState<AppAlertRequest[]>([]);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    return registerAppAlertHost((request) => {
      setPending((previous) => [...previous, request]);
    });
  }, []);

  const current = pending[0];

  const dismiss = useCallback(() => {
    setPending((previous) => previous.slice(1));
  }, []);

  const handlePress = useCallback(
    (button: AlertButton) => {
      dismiss();
      button.onPress?.();
    },
    [dismiss],
  );

  const handleDismiss = useCallback(() => {
    if (!current) return;
    const cancelable = current.options?.cancelable ?? true;
    if (!cancelable) return;
    dismiss();
    current.options?.onDismiss?.();
  }, [current, dismiss]);

  if (Platform.OS !== 'web' || !current) return null;

  return (
    <Portal>
      <Dialog visible onDismiss={handleDismiss} style={styles.dialog}>
        <Dialog.Title>{current.title}</Dialog.Title>
        {current.message ? (
          <Dialog.Content>
            <Text variant="bodyMedium">{current.message}</Text>
          </Dialog.Content>
        ) : null}
        <Dialog.Actions>
          {current.buttons.map((button, index) => (
            <Button
              key={`${current.id}-${index}`}
              onPress={() => handlePress(button)}
              textColor={button.style === 'destructive' ? '#FF3B30' : undefined}
              accessibilityLabel={button.text ?? 'OK'}
            >
              {button.text ?? 'OK'}
            </Button>
          ))}
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  dialog: {
    alignSelf: 'center',
    maxWidth: 480,
    minWidth: 320,
    width: '90%',
  },
});
