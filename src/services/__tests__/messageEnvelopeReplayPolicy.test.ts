import { beforeEach, describe, expect, it, vi } from 'vitest';

const signal = vi.hoisted(() => ({
  decryptEnvelope: vi.fn(),
  encryptForAllDevices: vi.fn(),
  getCachedSignalDeviceId: vi.fn(() => 3),
  listSignalDevices: vi.fn(),
  markSessionForRebuild: vi.fn(async () => undefined),
}));

vi.mock('../signalCryptoService', () => ({
  decryptEnvelope: signal.decryptEnvelope,
  encryptForAllDevices: signal.encryptForAllDevices,
  getCachedSignalDeviceId: signal.getCachedSignalDeviceId,
  listSignalDevices: signal.listSignalDevices,
  markSessionForRebuild: signal.markSessionForRebuild,
}));

vi.mock('../../../modules/splitcircle-crypto', () => ({
  isCryptoAvailable: () => true,
}));

import {
  decryptMessageEnvelope,
  EncryptionRequiredError,
  encryptMessageForRecipient,
  isDuplicateSignalMessageError,
} from '../messageEnvelope';

describe('Signal replay repair policy', () => {
  beforeEach(() => {
    signal.decryptEnvelope.mockReset();
    signal.encryptForAllDevices.mockReset();
    signal.getCachedSignalDeviceId.mockReturnValue(3);
    signal.listSignalDevices.mockReset();
    signal.markSessionForRebuild.mockClear();
  });

  it('recognizes the typed native duplicate-message exception', () => {
    expect(isDuplicateSignalMessageError({
      code: 'DuplicateSignalMessage',
      message: 'message counter already consumed',
    })).toBe(true);
    expect(isDuplicateSignalMessageError(new Error('invalid session'))).toBe(false);
  });

  it('does not poison a healthy session when gossip repeats a ciphertext', async () => {
    signal.decryptEnvelope.mockRejectedValueOnce(Object.assign(
      new Error('DuplicateSignalMessage: message counter already consumed'),
      { code: 'DuplicateSignalMessage' },
    ));

    await expect(decryptMessageEnvelope('peer', 7, { t: 2, b: 'ciphertext' }))
      .resolves.toBeNull();
    expect(signal.markSessionForRebuild).not.toHaveBeenCalled();
  });

  it('still requests repair for an actual decrypt failure', async () => {
    signal.decryptEnvelope.mockRejectedValueOnce(new Error('invalid session'));

    await expect(decryptMessageEnvelope('peer', 7, { t: 2, b: 'ciphertext' }))
      .resolves.toBeNull();
    expect(signal.markSessionForRebuild).toHaveBeenCalledWith('peer', 7);
  });

  it('keeps cloud sends strict but lets nearby cover every healthy device', async () => {
    signal.listSignalDevices.mockResolvedValue([
      { deviceId: 'ready', signalDeviceId: 7 },
      { deviceId: 'stale', signalDeviceId: 8 },
    ]);
    signal.encryptForAllDevices.mockResolvedValue([
      {
        deviceId: 'ready',
        signalDeviceId: 7,
        envelope: { type: 2, body: 'ciphertext' },
      },
    ]);

    await expect(encryptMessageForRecipient('peer', { content: 'hello' }))
      .rejects.toBeInstanceOf(EncryptionRequiredError);
    await expect(encryptMessageForRecipient(
      'peer',
      { content: 'hello' },
      undefined,
      'cache-only',
      'available-devices',
    )).resolves.toEqual({
      senderSignalDeviceId: 3,
      envelopes: { ready: { t: 2, b: 'ciphertext' } },
    });
  });
});
