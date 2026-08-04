export interface SignalDeviceDirectoryEntry {
  deviceId: string;
  signalDeviceId: number;
  identityKey: string | null;
  /** iOS NSE preview public key; absent on Android and pre-migration iPhones. */
  notificationPreviewIdentityKey?: string | null;
}

export const normalizeSignalDeviceDirectory = (
  value: unknown,
): SignalDeviceDirectoryEntry[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is SignalDeviceDirectoryEntry =>
      Boolean(item)
      && typeof item.deviceId === 'string'
      && item.deviceId.length > 0
      && Number.isFinite(item.signalDeviceId)
      && item.signalDeviceId > 0
      && (typeof item.identityKey === 'string' || item.identityKey === null),
  );
};

/**
 * A native Firestore JS query can return a partial or empty memory-cache
 * snapshot while offline. Never let that erase devices learned from an earlier
 * online run. A server-backed result remains authoritative.
 */
export const resolveSignalDeviceDirectory = ({
  remote,
  durable,
  remoteFromCache,
}: {
  remote: SignalDeviceDirectoryEntry[];
  durable: SignalDeviceDirectoryEntry[];
  remoteFromCache: boolean;
}): SignalDeviceDirectoryEntry[] => {
  if (!remoteFromCache) return remote;

  const merged = new Map(durable.map((device) => [device.deviceId, device]));
  for (const device of remote) merged.set(device.deviceId, device);
  return [...merged.values()];
};
