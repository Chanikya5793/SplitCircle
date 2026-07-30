import * as Crypto from 'expo-crypto';
import {
  sendNearbyPairingEnvelope,
  setNearbyPairingMode,
  type MeshStateEvent,
} from '../../modules/splitcircle-mesh';
import {
  bootstrapSignalIdentity,
  signWithIdentity,
  verifyWithIdentity,
} from '../../modules/splitcircle-crypto';
import {
  getPersistedSignalDeviceId,
  persistPairedSignalDevice,
} from '@/services/signalCryptoService';
import {
  rememberPairedNearbyPeer,
  type PairedNearbyPeer,
} from '@/services/nearbyPairingTrustService';

const PAIRING_PREFIX = 'manasplit-pair-v1|';
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type PairingPhase =
  | 'idle'
  | 'showing-code'
  | 'entering-code'
  | 'searching'
  | 'verifying'
  | 'paired'
  | 'error';

export interface NearbyPairingSnapshot {
  phase: PairingPhase;
  role?: 'host' | 'joiner';
  code?: string;
  expiresAt?: number;
  candidateCount: number;
  pairedPeer?: PairedNearbyPeer;
  errorMessage?: string;
  lastChangedAt: number;
}

interface LocalPairingIdentity {
  userId: string;
  deviceId: string;
  displayName: string;
  signalDeviceId: number;
  identityKey: string;
}

interface SignedPairingWire {
  v: 1;
  payloadBase64: string;
  signatureBase64: string;
}

interface OfferPayload {
  v: 1;
  kind: 'offer';
  pairingId: string;
  challenge: string;
  expiresAt: number;
  hostDeviceId: string;
  hostSignalDeviceId: number;
  hostIdentityKey: string;
}

interface ResponsePayload {
  v: 1;
  kind: 'response';
  pairingId: string;
  targetDeviceId: string;
  proof: string;
  peer: LocalPairingIdentity;
}

interface AcceptPayload {
  v: 1;
  kind: 'accept';
  pairingId: string;
  targetDeviceId: string;
  proof: string;
  host: LocalPairingIdentity;
}

interface RejectPayload {
  v: 1;
  kind: 'reject';
  pairingId: string;
  targetDeviceId: string;
  reason: 'code-mismatch' | 'expired' | 'busy';
}

type PairingPayload =
  | OfferPayload
  | ResponsePayload
  | AcceptPayload
  | RejectPayload;

interface HostSession {
  pairingId: string;
  challenge: string;
  code: string;
  expiresAt: number;
}

interface JoinSession {
  code: string;
  expiresAt: number;
  offer?: OfferPayload;
  proof?: string;
}

const listeners = new Set<() => void>();
let snapshot: NearbyPairingSnapshot = {
  phase: 'idle',
  candidateCount: 0,
  lastChangedAt: Date.now(),
};
let localIdentity: LocalPairingIdentity | null = null;
let identityPromise: Promise<LocalPairingIdentity> | null = null;
let hostSession: HostSession | null = null;
let joinSession: JoinSession | null = null;
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
let pairingAttempts = 0;
let onPaired: ((peer: PairedNearbyPeer) => void) | undefined;
const offeredDeviceIds = new Set<string>();
const seenResponseProofs = new Set<string>();

const isLocalPairingIdentity = (
  value: unknown,
): value is LocalPairingIdentity => {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<LocalPairingIdentity>;
  return typeof identity.userId === 'string'
    && identity.userId.length > 0
    && identity.userId.length <= 256
    && typeof identity.deviceId === 'string'
    && identity.deviceId.length > 0
    && identity.deviceId.length <= 63
    && typeof identity.displayName === 'string'
    && identity.displayName.length > 0
    && identity.displayName.length <= 80
    && Number.isFinite(identity.signalDeviceId)
    && Number(identity.signalDeviceId) > 0
    && Number(identity.signalDeviceId) <= 127
    && typeof identity.identityKey === 'string'
    && identity.identityKey.length > 0
    && identity.identityKey.length <= 2_048;
};

const publish = (next: Omit<NearbyPairingSnapshot, 'lastChangedAt'>): void => {
  snapshot = { ...next, lastChangedAt: Date.now() };
  listeners.forEach((listener) => listener());
};

export const getNearbyPairingSnapshot = (): NearbyPairingSnapshot => snapshot;

export const subscribeToNearbyPairing = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const encodeUtf8Base64 = (value: string): string =>
  globalThis.btoa(unescape(encodeURIComponent(value)));

const decodeUtf8Base64 = (value: string): string =>
  decodeURIComponent(escape(globalThis.atob(value)));

const randomHex = async (byteCount: number): Promise<string> =>
  Array.from(await Crypto.getRandomBytesAsync(byteCount))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const randomCode = async (): Promise<string> => {
  const bytes = await Crypto.getRandomBytesAsync(8);
  return Array.from(bytes)
    .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join('');
};

export const normalizeNearbyPairingCode = (value: string): string =>
  [...value.toUpperCase()]
    .filter((character) => CODE_ALPHABET.includes(character))
    .join('')
    .slice(0, 8);

export const formatNearbyPairingCode = (value: string): string => {
  const code = normalizeNearbyPairingCode(value);
  return code.length > 4 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
};

const digest = (value: string): Promise<string> =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);

export const createNearbyPairingProof = ({
  code,
  pairingId,
  challenge,
  hostDeviceId,
  hostIdentityKey,
  peerDeviceId,
  peerIdentityKey,
}: {
  code: string;
  pairingId: string;
  challenge: string;
  hostDeviceId: string;
  hostIdentityKey: string;
  peerDeviceId: string;
  peerIdentityKey: string;
}): Promise<string> => digest([
  'ManaSplit nearby pairing v1',
  normalizeNearbyPairingCode(code),
  pairingId,
  challenge,
  hostDeviceId,
  hostIdentityKey,
  peerDeviceId,
  peerIdentityKey,
].join('|'));

const pairingProof = ({
  code,
  offer,
  peer,
}: {
  code: string;
  offer: OfferPayload;
  peer: LocalPairingIdentity;
}): Promise<string> => createNearbyPairingProof({
  code,
  pairingId: offer.pairingId,
  challenge: offer.challenge,
  hostDeviceId: offer.hostDeviceId,
  hostIdentityKey: offer.hostIdentityKey,
  peerDeviceId: peer.deviceId,
  peerIdentityKey: peer.identityKey,
});

const signPayload = async (payload: PairingPayload): Promise<string> => {
  const payloadBase64 = encodeUtf8Base64(JSON.stringify(payload));
  return `${PAIRING_PREFIX}${encodeUtf8Base64(JSON.stringify({
    v: 1,
    payloadBase64,
    signatureBase64: await signWithIdentity(payloadBase64),
  } satisfies SignedPairingWire))}`;
};

const parseWire = (
  raw: string,
): { wire: SignedPairingWire; payload: PairingPayload } | null => {
  if (!raw.startsWith(PAIRING_PREFIX) || raw.length > 32 * 1024) return null;
  try {
    const wire = JSON.parse(
      decodeUtf8Base64(raw.slice(PAIRING_PREFIX.length)),
    ) as Partial<SignedPairingWire>;
    if (
      wire.v !== 1
      || typeof wire.payloadBase64 !== 'string'
      || typeof wire.signatureBase64 !== 'string'
    ) {
      return null;
    }
    const payload = JSON.parse(
      decodeUtf8Base64(wire.payloadBase64),
    ) as PairingPayload;
    if (
      payload.v !== 1
      || !['offer', 'response', 'accept', 'reject'].includes(payload.kind)
    ) {
      return null;
    }
    return { wire: wire as SignedPairingWire, payload };
  } catch {
    return null;
  }
};

const ensureIdentity = async (): Promise<LocalPairingIdentity> => {
  if (localIdentity) return localIdentity;
  if (identityPromise) return identityPromise;
  throw new Error('Nearby identity is still preparing. Try again in a moment.');
};

const closePairingWindow = (resetState: boolean): void => {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = undefined;
  hostSession = null;
  joinSession = null;
  pairingAttempts = 0;
  offeredDeviceIds.clear();
  seenResponseProofs.clear();
  setNearbyPairingMode(false);
  if (resetState) {
    publish({ phase: 'idle', candidateCount: 0 });
  }
};

const armExpiry = (expiresAt: number): void => {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => {
    closePairingWindow(false);
    publish({
      phase: 'error',
      candidateCount: 0,
      errorMessage: 'The pairing window expired. Start again on both phones.',
    });
  }, Math.max(0, expiresAt - Date.now()));
};

export const configureNearbyPairing = ({
  userId,
  deviceId,
  displayName,
  handlePaired,
}: {
  userId: string;
  deviceId: string;
  displayName: string;
  handlePaired: (peer: PairedNearbyPeer) => void;
}): void => {
  localIdentity = null;
  onPaired = handlePaired;
  identityPromise = (async () => {
    const signalDeviceId = await getPersistedSignalDeviceId();
    if (!signalDeviceId) {
      throw new Error('Secure identity is unavailable until this phone has signed in online once.');
    }
    const identity = await bootstrapSignalIdentity(userId, signalDeviceId);
    localIdentity = {
      userId,
      deviceId,
      displayName: displayName.trim().slice(0, 80) || 'ManaSplit user',
      signalDeviceId,
      identityKey: identity.identityKey,
    };
    return localIdentity;
  })();
  void identityPromise.catch(() => undefined);
};

export const startNearbyPairingHost = async (): Promise<void> => {
  await ensureIdentity();
  closePairingWindow(false);
  const code = await randomCode();
  const expiresAt = Date.now() + PAIRING_WINDOW_MS;
  hostSession = {
    pairingId: await randomHex(16),
    challenge: await randomHex(24),
    code,
    expiresAt,
  };
  setNearbyPairingMode(true);
  armExpiry(expiresAt);
  publish({
    phase: 'showing-code',
    role: 'host',
    code,
    expiresAt,
    candidateCount: 0,
  });
};

export const startNearbyPairingJoin = async (enteredCode: string): Promise<void> => {
  await ensureIdentity();
  const code = normalizeNearbyPairingCode(enteredCode);
  if (code.length !== 8) throw new Error('Enter the complete 8-character code.');
  closePairingWindow(false);
  const expiresAt = Date.now() + PAIRING_WINDOW_MS;
  joinSession = { code, expiresAt };
  setNearbyPairingMode(true);
  armExpiry(expiresAt);
  publish({
    phase: 'searching',
    role: 'joiner',
    expiresAt,
    candidateCount: 0,
  });
};

export const cancelNearbyPairing = (): void => closePairingWindow(true);

const offerToDevice = async (deviceId: string): Promise<void> => {
  const identity = await ensureIdentity();
  const current = hostSession;
  if (!current || current.expiresAt <= Date.now()) return;
  const payload: OfferPayload = {
    v: 1,
    kind: 'offer',
    pairingId: current.pairingId,
    challenge: current.challenge,
    expiresAt: current.expiresAt,
    hostDeviceId: identity.deviceId,
    hostSignalDeviceId: identity.signalDeviceId,
    hostIdentityKey: identity.identityKey,
  };
  const sent = await sendNearbyPairingEnvelope(
    await signPayload(payload),
    [deviceId],
  );
  if (sent > 0) offeredDeviceIds.add(deviceId);
};

export const handleNearbyPairingMeshState = (event: MeshStateEvent): void => {
  const candidates = event.pairingDeviceIds ?? [];
  if (snapshot.phase !== 'idle' && snapshot.phase !== 'paired') {
    publish({
      ...snapshot,
      candidateCount: candidates.length,
      phase: candidates.length > 0 && snapshot.phase === 'showing-code'
        ? 'verifying'
        : snapshot.phase,
    });
  }
  if (!hostSession) return;
  for (const deviceId of candidates) {
    if (!offeredDeviceIds.has(deviceId)) {
      void offerToDevice(deviceId).catch(() => {
        offeredDeviceIds.delete(deviceId);
      });
    }
  }
};

const commitPeer = async (
  peer: LocalPairingIdentity,
): Promise<PairedNearbyPeer> => {
  const identity = await ensureIdentity();
  if (
    peer.deviceId === identity.deviceId
    || peer.userId === identity.userId
    || !peer.deviceId
    || !peer.userId
    || !peer.identityKey
  ) {
    throw new Error('The pairing identity is not a different valid account.');
  }
  await persistPairedSignalDevice(peer);
  const remembered = await rememberPairedNearbyPeer(identity.userId, {
    deviceId: peer.deviceId,
    userId: peer.userId,
    label: peer.displayName,
    signalDeviceId: peer.signalDeviceId,
    identityKey: peer.identityKey,
  });
  onPaired?.(remembered);
  return remembered;
};

const handleOffer = async (
  wire: SignedPairingWire,
  offer: OfferPayload,
  sourceDeviceId: string,
): Promise<void> => {
  const identity = await ensureIdentity();
  const current = joinSession;
  if (
    !current
    || offer.expiresAt <= Date.now()
    || offer.hostDeviceId !== sourceDeviceId
    || offer.hostDeviceId === identity.deviceId
    || !Number.isFinite(offer.hostSignalDeviceId)
    || offer.hostSignalDeviceId <= 0
    || offer.hostSignalDeviceId > 127
    || typeof offer.pairingId !== 'string'
    || offer.pairingId.length !== 32
    || typeof offer.challenge !== 'string'
    || offer.challenge.length !== 48
    || !offer.hostIdentityKey
    || offer.hostIdentityKey.length > 2_048
  ) {
    return;
  }
  const valid = await verifyWithIdentity(
    wire.payloadBase64,
    wire.signatureBase64,
    offer.hostIdentityKey,
  );
  if (!valid) return;

  const proof = await pairingProof({ code: current.code, offer, peer: identity });
  current.offer = offer;
  current.proof = proof;
  publish({
    phase: 'verifying',
    role: 'joiner',
    expiresAt: current.expiresAt,
    candidateCount: Math.max(1, snapshot.candidateCount),
  });
  await sendNearbyPairingEnvelope(
    await signPayload({
      v: 1,
      kind: 'response',
      pairingId: offer.pairingId,
      targetDeviceId: offer.hostDeviceId,
      proof,
      peer: identity,
    }),
    [sourceDeviceId],
  );
};

const handleResponse = async (
  wire: SignedPairingWire,
  response: ResponsePayload,
  sourceDeviceId: string,
): Promise<void> => {
  const identity = await ensureIdentity();
  const current = hostSession;
  if (
    !current
    || current.expiresAt <= Date.now()
    || response.pairingId !== current.pairingId
    || response.targetDeviceId !== identity.deviceId
    || !isLocalPairingIdentity(response.peer)
    || typeof response.proof !== 'string'
    || response.proof.length !== 64
    || response.peer?.deviceId !== sourceDeviceId
    || response.peer.userId === identity.userId
  ) {
    return;
  }
  const signed = await verifyWithIdentity(
    wire.payloadBase64,
    wire.signatureBase64,
    response.peer.identityKey,
  );
  const offer: OfferPayload = {
    v: 1,
    kind: 'offer',
    pairingId: current.pairingId,
    challenge: current.challenge,
    expiresAt: current.expiresAt,
    hostDeviceId: identity.deviceId,
    hostSignalDeviceId: identity.signalDeviceId,
    hostIdentityKey: identity.identityKey,
  };
  const expected = await pairingProof({
    code: current.code,
    offer,
    peer: response.peer,
  });
  if (!signed || expected !== response.proof) {
    const attemptKey = `${sourceDeviceId}|${response.proof}`;
    if (!seenResponseProofs.has(attemptKey)) {
      seenResponseProofs.add(attemptKey);
      pairingAttempts += 1;
    }
    await sendNearbyPairingEnvelope(
      await signPayload({
        v: 1,
        kind: 'reject',
        pairingId: current.pairingId,
        targetDeviceId: sourceDeviceId,
        reason: 'code-mismatch',
      }),
      [sourceDeviceId],
    );
    publish({
      phase: 'error',
      role: 'host',
      code: current.code,
      expiresAt: current.expiresAt,
      candidateCount: snapshot.candidateCount,
      errorMessage: pairingAttempts >= MAX_PAIRING_ATTEMPTS
        ? 'Too many incorrect attempts. Start a new pairing code.'
        : 'That phone entered a different pairing code.',
    });
    if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) closePairingWindow(false);
    return;
  }

  publish({
    phase: 'verifying',
    role: 'host',
    code: current.code,
    expiresAt: current.expiresAt,
    candidateCount: snapshot.candidateCount,
  });
  // Consume the one-time host session before awaiting the reliable send so a
  // duplicate response cannot race a second trust commit.
  hostSession = null;
  const accepted = await sendNearbyPairingEnvelope(
    await signPayload({
      v: 1,
      kind: 'accept',
      pairingId: current.pairingId,
      targetDeviceId: sourceDeviceId,
      proof: response.proof,
      host: identity,
    }),
    [sourceDeviceId],
  );
  if (accepted === 0) throw new Error('The other phone left before pairing completed.');
  const remembered = await commitPeer(response.peer);
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = undefined;
  publish({
    phase: 'paired',
    role: 'host',
    candidateCount: 1,
    pairedPeer: remembered,
  });
  setTimeout(() => {
    if (snapshot.phase === 'paired') setNearbyPairingMode(false);
  }, 1_500);
};

const handleAccept = async (
  wire: SignedPairingWire,
  accept: AcceptPayload,
  sourceDeviceId: string,
): Promise<void> => {
  const identity = await ensureIdentity();
  const current = joinSession;
  const offer = current?.offer;
  if (
    !current
    || !offer
    || accept.pairingId !== offer.pairingId
    || accept.targetDeviceId !== identity.deviceId
    || !isLocalPairingIdentity(accept.host)
    || typeof accept.proof !== 'string'
    || accept.proof.length !== 64
    || accept.host?.deviceId !== sourceDeviceId
    || accept.host.identityKey !== offer.hostIdentityKey
    || accept.proof !== current.proof
  ) {
    return;
  }
  const valid = await verifyWithIdentity(
    wire.payloadBase64,
    wire.signatureBase64,
    offer.hostIdentityKey,
  );
  if (!valid) return;
  // Accept is single-use. Consume it before persistence so duplicate frames
  // cannot start concurrent durable-directory rewrites.
  joinSession = null;
  const remembered = await commitPeer(accept.host);
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = undefined;
  publish({
    phase: 'paired',
    role: 'joiner',
    candidateCount: 1,
    pairedPeer: remembered,
  });
  setTimeout(() => {
    if (snapshot.phase === 'paired') setNearbyPairingMode(false);
  }, 1_500);
};

const handleReject = async (
  wire: SignedPairingWire,
  reject: RejectPayload,
  sourceDeviceId: string,
): Promise<void> => {
  const identity = await ensureIdentity();
  const current = joinSession;
  const offer = current?.offer;
  if (
    !current
    || !offer
    || reject.pairingId !== offer.pairingId
    || reject.targetDeviceId !== identity.deviceId
    || offer.hostDeviceId !== sourceDeviceId
  ) {
    return;
  }
  const valid = await verifyWithIdentity(
    wire.payloadBase64,
    wire.signatureBase64,
    offer.hostIdentityKey,
  );
  if (!valid) return;
  publish({
    phase: 'error',
    role: 'joiner',
    expiresAt: current.expiresAt,
    candidateCount: snapshot.candidateCount,
    errorMessage: reject.reason === 'code-mismatch'
      ? 'The code did not match. Check both phones and try again.'
      : 'The other phone ended this pairing attempt.',
  });
};

/**
 * Returns true for every frame in the pairing namespace, even malformed
 * frames, so a pairing probe can never fall through into chat parsing.
 */
export const handleNearbyPairingEnvelope = (
  raw: string,
  sourceDeviceId: string,
): boolean => {
  if (!raw.startsWith(PAIRING_PREFIX)) return false;
  const parsed = parseWire(raw);
  if (!parsed) return true;
  const work = parsed.payload.kind === 'offer'
    ? handleOffer(parsed.wire, parsed.payload, sourceDeviceId)
    : parsed.payload.kind === 'response'
      ? handleResponse(parsed.wire, parsed.payload, sourceDeviceId)
      : parsed.payload.kind === 'accept'
        ? handleAccept(parsed.wire, parsed.payload, sourceDeviceId)
        : handleReject(parsed.wire, parsed.payload, sourceDeviceId);
  void work.catch((error) => {
    publish({
      phase: 'error',
      role: snapshot.role,
      code: snapshot.code,
      expiresAt: snapshot.expiresAt,
      candidateCount: snapshot.candidateCount,
      errorMessage: error instanceof Error
        ? error.message
        : 'Secure nearby pairing could not finish.',
    });
  });
  return true;
};
