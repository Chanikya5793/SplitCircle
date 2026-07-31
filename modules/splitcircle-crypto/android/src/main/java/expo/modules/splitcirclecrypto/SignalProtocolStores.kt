package expo.modules.splitcirclecrypto

import android.content.Context
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.ReusedBaseKeyException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.groups.state.SenderKeyRecord
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SignalProtocolStore
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.IdentityKeyStore.Direction
import org.signal.libsignal.protocol.state.IdentityKeyStore.IdentityChange
import java.util.UUID

/**
 * Durable `SignalProtocolStore` — the Android mirror of
 * `ios/SignalProtocolStores.swift` (doc 33 Phase 1).
 *
 * libsignal ships `InMemorySignalProtocolStore`, which is fine for a linkage
 * spike and useless in production: a device that forgets its sessions on
 * restart is WORSE than one that never had them, because peers keep encrypting
 * to a ratchet state it can no longer advance, and every message from them
 * fails to decrypt until both sides re-pair.
 *
 * Every record is persisted through [SignalBlobStore] as libsignal hands it
 * over. Key shapes are namespaced per record type, and the address encoding
 * (`name::deviceId`) is the only thing that maps a peer to its session, so it
 * must never change without a migration.
 */
class DurableSignalProtocolStore(
  context: Context,
  private val identityKeyPair: IdentityKeyPair,
  private val registrationId: Int,
) : SignalProtocolStore {

  private val sessions = SignalBlobStore(context, "session")
  private val preKeys = SignalBlobStore(context, "prekey")
  private val signedPreKeys = SignalBlobStore(context, "signedprekey")
  private val kyberPreKeys = SignalBlobStore(context, "kyberprekey")
  private val identities = SignalBlobStore(context, "peeridentity")
  private val senderKeys = SignalBlobStore(context, "senderkey")

  /**
   * `::` separator, not `:`. A libsignal address name is a user id, and while
   * ours are Firebase uids today, a single-colon join would be ambiguous the
   * moment a name could itself contain a colon — silently aliasing two peers
   * onto one session, which is a catastrophic and near-undebuggable failure.
   */
  private fun addressKey(address: SignalProtocolAddress) =
    "${address.name}::${address.deviceId}"

  // ── IdentityKeyStore ───────────────────────────────────────────────────────

  override fun getIdentityKeyPair(): IdentityKeyPair = identityKeyPair

  override fun getLocalRegistrationId(): Int = registrationId

  override fun saveIdentity(address: SignalProtocolAddress, identity: IdentityKey): IdentityChange {
    val key = addressKey(address)
    val existing = identities.get(key)
    identities.set(key, identity.serialize())
    // REPLACED_EXISTING is what tells callers the peer's identity changed —
    // a reinstall, restore, or an attack. The app surfaces that as a session
    // repair (see signalCryptoService's identity-change handling); reporting
    // NEW_OR_UNCHANGED here would hide it.
    return when {
      existing == null -> IdentityChange.NEW_OR_UNCHANGED
      existing.contentEquals(identity.serialize()) -> IdentityChange.NEW_OR_UNCHANGED
      else -> IdentityChange.REPLACED_EXISTING
    }
  }

  /**
   * Trust-on-first-use, matching iOS. An unknown peer is trusted (there is no
   * prior key to contradict); a KNOWN peer whose key changed is NOT, so the
   * caller must explicitly re-establish rather than silently ratcheting to a
   * new identity.
   */
  override fun isTrustedIdentity(
    address: SignalProtocolAddress,
    identity: IdentityKey,
    direction: Direction,
  ): Boolean {
    val known = identities.get(addressKey(address)) ?: return true
    return known.contentEquals(identity.serialize())
  }

  override fun getIdentity(address: SignalProtocolAddress): IdentityKey? =
    identities.get(addressKey(address))?.let { IdentityKey(it) }

  // ── SessionStore ───────────────────────────────────────────────────────────

  override fun loadSession(address: SignalProtocolAddress): SessionRecord? =
    sessions.get(addressKey(address))?.let { SessionRecord(it) }

  override fun loadExistingSessions(
    addresses: List<SignalProtocolAddress>,
  ): List<SessionRecord> = addresses.map { address ->
    val bytes = sessions.get(addressKey(address))
      ?: throw NoSessionException("No session for ${addressKey(address)}")
    SessionRecord(bytes)
  }

  override fun getSubDeviceSessions(name: String): List<Int> =
    sessions.keys()
      .mapNotNull { key ->
        val parts = key.split("::")
        if (parts.size == 2 && parts[0] == name) parts[1].toIntOrNull() else null
      }
      // Device 1 is the primary; libsignal's contract is SUB-device ids only.
      .filter { it != 1 }

  override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) =
    sessions.set(addressKey(address), record.serialize())

  override fun containsSession(address: SignalProtocolAddress): Boolean =
    sessions.has(addressKey(address))

  override fun deleteSession(address: SignalProtocolAddress) =
    sessions.delete(addressKey(address))

  override fun deleteAllSessions(name: String) {
    sessions.keys().filter { it.startsWith("$name::") }.forEach { sessions.delete(it) }
  }

  // ── PreKeyStore ────────────────────────────────────────────────────────────

  override fun loadPreKey(id: Int): PreKeyRecord =
    preKeys.get(id.toString())?.let { PreKeyRecord(it) }
      ?: throw InvalidKeyIdException("No prekey $id")

  override fun storePreKey(id: Int, record: PreKeyRecord) =
    preKeys.set(id.toString(), record.serialize())

  override fun containsPreKey(id: Int): Boolean = preKeys.has(id.toString())

  /**
   * A one-time prekey is consumed on use and must never be reissued — that is
   * the whole point of "one-time", and reuse degrades forward secrecy.
   */
  override fun removePreKey(id: Int) = preKeys.delete(id.toString())

  // ── SignedPreKeyStore ──────────────────────────────────────────────────────

  override fun loadSignedPreKey(id: Int): SignedPreKeyRecord =
    signedPreKeys.get(id.toString())?.let { SignedPreKeyRecord(it) }
      ?: throw InvalidKeyIdException("No signed prekey $id")

  override fun loadSignedPreKeys(): List<SignedPreKeyRecord> =
    signedPreKeys.keys().mapNotNull { k ->
      signedPreKeys.get(k)?.let { runCatching { SignedPreKeyRecord(it) }.getOrNull() }
    }

  override fun storeSignedPreKey(id: Int, record: SignedPreKeyRecord) =
    signedPreKeys.set(id.toString(), record.serialize())

  override fun containsSignedPreKey(id: Int): Boolean = signedPreKeys.has(id.toString())

  override fun removeSignedPreKey(id: Int) = signedPreKeys.delete(id.toString())

  // ── KyberPreKeyStore ───────────────────────────────────────────────────────

  override fun loadKyberPreKey(id: Int): KyberPreKeyRecord =
    kyberPreKeys.get(id.toString())?.let { KyberPreKeyRecord(it) }
      ?: throw InvalidKeyIdException("No kyber prekey $id")

  override fun loadKyberPreKeys(): List<KyberPreKeyRecord> =
    kyberPreKeys.keys().mapNotNull { k ->
      kyberPreKeys.get(k)?.let { runCatching { KyberPreKeyRecord(it) }.getOrNull() }
    }

  override fun storeKyberPreKey(id: Int, record: KyberPreKeyRecord) =
    kyberPreKeys.set(id.toString(), record.serialize())

  override fun containsKyberPreKey(id: Int): Boolean = kyberPreKeys.has(id.toString())

  /**
   * Our kyber prekeys are LAST-RESORT keys (one per bundle, reused across
   * handshakes), so this is intentionally not a delete — matching iOS, which
   * also keeps them. Removing it here would break every subsequent handshake
   * that referenced the same published bundle.
   *
   * The base-key record exists to reject a replayed handshake: the same base
   * key arriving twice against one kyber prekey is a replay, not a new
   * session, and libsignal expects `ReusedBaseKeyException`.
   */
  override fun markKyberPreKeyUsed(id: Int, signedPreKeyId: Int, baseKey: ECPublicKey) {
    val marker = "used::$id::$signedPreKeyId"
    val serialized = baseKey.serialize()
    kyberPreKeys.get(marker)?.let { previous ->
      if (previous.contentEquals(serialized)) {
        throw ReusedBaseKeyException("Base key already used for kyber prekey $id")
      }
    }
    kyberPreKeys.set(marker, serialized)
  }

  // ── SenderKeyStore ─────────────────────────────────────────────────────────
  // Not used yet: group messages are fanned out per-device rather than via
  // sender keys (doc 31 §3.3). Implemented rather than stubbed so enabling
  // sender keys later does not silently lose state.

  private fun senderKeyKey(sender: SignalProtocolAddress, distributionId: UUID) =
    "${addressKey(sender)}::$distributionId"

  override fun storeSenderKey(
    sender: SignalProtocolAddress,
    distributionId: UUID,
    record: SenderKeyRecord,
  ) = senderKeys.set(senderKeyKey(sender, distributionId), record.serialize())

  override fun loadSenderKey(
    sender: SignalProtocolAddress,
    distributionId: UUID,
  ): SenderKeyRecord? =
    senderKeys.get(senderKeyKey(sender, distributionId))?.let { SenderKeyRecord(it) }

  /** Wipes every namespace. Device revocation and account deletion. */
  fun wipe() {
    sessions.removeAll()
    preKeys.removeAll()
    signedPreKeys.removeAll()
    kyberPreKeys.removeAll()
    identities.removeAll()
    senderKeys.removeAll()
  }
}
