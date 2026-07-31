package expo.modules.splitcirclecrypto

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.message.CiphertextMessage
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.util.KeyHelper
import java.security.SecureRandom

/**
 * Android `SplitCircleCrypto` — per-device Signal sessions (doc 31 §3.3,
 * doc 33 Phase 1). Mirrors `ios/SplitCircleCryptoModule.swift` function for
 * function; the JS layer in `modules/splitcircle-crypto/index.ts` is shared and
 * must not need to know which platform it is on.
 *
 * Built against libsignal 0.99.1 compiled from source — the SAME version iOS
 * pins — so both ends produce identical wire bytes. See doc 33 §3.1 for why
 * Maven's 0.86.5 is not an option and `scripts/build-libsignal-android.sh` for
 * how to reproduce the artifacts.
 *
 * Every export throws rather than silently degrading. A "quietly unencrypted"
 * fallback is the one failure mode this module must never have — on Android it
 * is exactly what happened while this module did not exist (doc 32 §10):
 * `isCryptoAvailable()` returned false and `queueMessage` shipped plaintext.
 */
class SplitCircleCryptoModule : Module() {

  private var store: DurableSignalProtocolStore? = null
  private var localAddress: SignalProtocolAddress? = null

  /** All libsignal state mutation is serialized. Ratchets are not reentrant. */
  private val lock = Any()

  private val context
    get() = appContext.reactContext ?: throw CodedException("NoContext", "No Android context", null)

  private fun secrets() = SignalSecretStore(context)

  private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun unb64(value: String): ByteArray =
    runCatching { Base64.decode(value, Base64.DEFAULT) }
      .getOrElse { throw CodedException("InvalidArgument", "Expected base64", null) }

  /**
   * Rehydrates the store from disk. Called by every operation rather than
   * assuming `bootstrap` ran this process: Android can restart the JS runtime
   * without restarting the process, and a store that silently came back empty
   * would mint a second identity and orphan every existing session.
   */
  private fun requireStore(): DurableSignalProtocolStore = synchronized(lock) {
    store?.let { return it }
    val secrets = secrets()
    val identityBytes = secrets.get(SignalSecretStore.IDENTITY_KEY_PAIR)
      ?: throw CodedException("NotBootstrapped", "Signal identity not created yet", null)
    val registrationId = secrets.get(SignalSecretStore.REGISTRATION_ID)
      ?.let { String(it).toIntOrNull() }
      ?: throw CodedException("NotBootstrapped", "Missing registration id", null)
    val deviceId = secrets.get(SignalSecretStore.DEVICE_ID)?.let { String(it).toIntOrNull() }
      ?: throw CodedException("NotBootstrapped", "Missing device id", null)
    val userId = secrets.get(SignalSecretStore.USER_ID)?.let { String(it) }
      ?: throw CodedException("NotBootstrapped", "Missing user id", null)

    val created = DurableSignalProtocolStore(context, IdentityKeyPair(identityBytes), registrationId)
    store = created
    localAddress = SignalProtocolAddress(userId, deviceId)
    return created
  }

  private fun requireLocalAddress(): SignalProtocolAddress {
    requireStore()
    return localAddress ?: throw CodedException("NotBootstrapped", "No local address", null)
  }


  /**
   * Converts a raw libsignal exception into a CodedException carrying the
   * exception's SIMPLE NAME as the code and its message as the description.
   *
   * Without this, a failure reaches JS as Expo's generic "Call to function
   * 'SplitCircleCrypto.decrypt' has been rejected. Caused by: org…" — and the
   * receive path truncates the reason to 80 characters, so the only thing a
   * user or a log ever saw was the literal string "org". A decrypt failure has
   * to name itself: NoSessionException and InvalidKeyIdException mean opposite
   * things (stale peer session vs missing prekey) and demand different repairs.
   */
  private inline fun <T> signalCall(operation: String, block: () -> T): T =
    try {
      block()
    } catch (e: CodedException) {
      throw e
    } catch (e: Throwable) {
      throw CodedException(
        e::class.java.simpleName.ifEmpty { "SignalError" },
        "$operation failed: ${e.message ?: e::class.java.name}",
        e,
      )
    }

  override fun definition() = ModuleDefinition {
    Name("SplitCircleCrypto")

    /**
     * Creates this device's identity if absent, or returns the existing one.
     * IDEMPOTENT and safe on every sign-in — minting a second identity would
     * invalidate every session peers already hold with this device.
     */
    AsyncFunction("bootstrap") { userId: String, deviceId: Int ->
      synchronized(lock) {
        val secrets = secrets()
        val existing = secrets.get(SignalSecretStore.IDENTITY_KEY_PAIR)
        val identity = if (existing != null) {
          IdentityKeyPair(existing)
        } else {
          IdentityKeyPair.generate().also {
            secrets.set(SignalSecretStore.IDENTITY_KEY_PAIR, it.serialize())
          }
        }
        val registrationId = secrets.get(SignalSecretStore.REGISTRATION_ID)
          ?.let { String(it).toIntOrNull() }
          ?: KeyHelper.generateRegistrationId(false).also {
            secrets.set(SignalSecretStore.REGISTRATION_ID, it.toString().toByteArray())
          }
        // The server allocates the small-integer device id, so a later call
        // with a corrected id must win rather than being pinned to the
        // provisional 1 that bootstrapSignalIdentity starts with.
        secrets.set(SignalSecretStore.DEVICE_ID, deviceId.toString().toByteArray())
        secrets.set(SignalSecretStore.USER_ID, userId.toByteArray())

        store = DurableSignalProtocolStore(context, identity, registrationId)
        localAddress = SignalProtocolAddress(userId, deviceId)

        mapOf(
          "registrationId" to registrationId,
          "identityKey" to b64(identity.publicKey.serialize()),
          "deviceId" to deviceId,
        )
      }
    }

    AsyncFunction("hasIdentity") {
      secrets().has(SignalSecretStore.IDENTITY_KEY_PAIR)
    }

    /**
     * Generates and PERSISTS a fresh publishable bundle. The private halves
     * must be stored before the public halves are published, or a peer could
     * claim a prekey this device cannot answer.
     */
    AsyncFunction("generatePublishableBundle") { oneTimeCount: Int ->
      synchronized(lock) {
        val store = requireStore()
        val identity = store.identityKeyPair
        val random = SecureRandom()

        val signedPreKeyId = random.nextInt(0xFFFFFF)
        val signedPreKey = ECKeyPair.generate()
        val signedSignature = identity.privateKey.calculateSignature(signedPreKey.publicKey.serialize())
        store.storeSignedPreKey(
          signedPreKeyId,
          SignedPreKeyRecord(signedPreKeyId, System.currentTimeMillis(), signedPreKey, signedSignature),
        )

        val kyberPreKeyId = random.nextInt(0xFFFFFF)
        val kyberPreKey = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
        val kyberSignature = identity.privateKey.calculateSignature(kyberPreKey.publicKey.serialize())
        store.storeKyberPreKey(
          kyberPreKeyId,
          KyberPreKeyRecord(kyberPreKeyId, System.currentTimeMillis(), kyberPreKey, kyberSignature),
        )

        val oneTime = (0 until oneTimeCount).map {
          val id = random.nextInt(0xFFFFFF)
          val pair = ECKeyPair.generate()
          store.storePreKey(id, PreKeyRecord(id, pair))
          mapOf("keyId" to id, "publicKey" to b64(pair.publicKey.serialize()))
        }

        mapOf(
          "registrationId" to store.localRegistrationId,
          "identityKey" to b64(identity.publicKey.serialize()),
          "signedPreKeyId" to signedPreKeyId,
          "signedPreKeyPublic" to b64(signedPreKey.publicKey.serialize()),
          "signedPreKeySignature" to b64(signedSignature),
          "kyberPreKeyId" to kyberPreKeyId,
          "kyberPreKeyPublic" to b64(kyberPreKey.publicKey.serialize()),
          "kyberPreKeySignature" to b64(kyberSignature),
          "oneTimePreKeys" to oneTime,
        )
      }
    }

    /**
     * PQXDH handshake from a peer's published bundle. `process` archives any
     * existing session and starts a new one, so this doubles as the repair
     * path after an identity change.
     */
    AsyncFunction("establishSession") { userId: String, deviceId: Int, bundle: Map<String, Any?> ->
      synchronized(lock) {
        val store = requireStore()
        val remote = SignalProtocolAddress(userId, deviceId)

        fun str(key: String): String = bundle[key] as? String
          ?: throw CodedException("MalformedBundle", "Missing $key", null)
        fun num(key: String): Int = (bundle[key] as? Number)?.toInt()
          ?: throw CodedException("MalformedBundle", "Missing $key", null)

        @Suppress("UNCHECKED_CAST")
        val oneTime = bundle["oneTimePreKey"] as? Map<String, Any?>
        // A bundle without a one-time prekey is LEGAL — the peer has run out,
        // and the handshake falls back to the signed prekey (weaker forward
        // secrecy, still valid). NULL_PRE_KEY_ID is how libsignal expresses it.
        val oneTimeId = (oneTime?.get("keyId") as? Number)?.toInt() ?: PreKeyBundle.NULL_PRE_KEY_ID
        val oneTimeKey = (oneTime?.get("publicKey") as? String)
          ?.let { org.signal.libsignal.protocol.ecc.ECPublicKey(unb64(it)) }

        val preKeyBundle = PreKeyBundle(
          num("registrationId"),
          deviceId,
          oneTimeId,
          oneTimeKey,
          num("signedPreKeyId"),
          org.signal.libsignal.protocol.ecc.ECPublicKey(unb64(str("signedPreKeyPublic"))),
          unb64(str("signedPreKeySignature")),
          IdentityKey(unb64(str("identityKey"))),
          num("kyberPreKeyId"),
          org.signal.libsignal.protocol.kem.KEMPublicKey(unb64(str("kyberPreKeyPublic"))),
          unb64(str("kyberPreKeySignature")),
        )

        // NOTE the argument order — SessionBuilder takes (store, REMOTE, LOCAL)
        // while SessionCipher below takes (store, LOCAL, REMOTE). Identical
        // types, so swapping them compiles and fails at runtime. Doc 33 §3.1.
        signalCall("establishSession(with=$userId.$deviceId)") {
          SessionBuilder(store, remote, requireLocalAddress()).process(preKeyBundle)
        }
      }
    }

    AsyncFunction("hasSession") { userId: String, deviceId: Int ->
      synchronized(lock) {
        requireStore().containsSession(SignalProtocolAddress(userId, deviceId))
      }
    }

    AsyncFunction("encrypt") { userId: String, deviceId: Int, plaintextBase64: String ->
      synchronized(lock) {
        val store = requireStore()
        val remote = SignalProtocolAddress(userId, deviceId)
        val message: CiphertextMessage = signalCall("encrypt(to=$userId.$deviceId)") {
          SessionCipher(store, requireLocalAddress(), remote).encrypt(unb64(plaintextBase64))
        }
        mapOf(
          // The receiver dispatches on this to choose the decrypt path; it is
          // protocol data, not a hint, so it travels with every envelope.
          "type" to message.type,
          "body" to b64(message.serialize()),
        )
      }
    }

    AsyncFunction("decrypt") { userId: String, deviceId: Int, type: Int, bodyBase64: String ->
      synchronized(lock) {
        val store = requireStore()
        val remote = SignalProtocolAddress(userId, deviceId)
        val cipher = SessionCipher(store, requireLocalAddress(), remote)
        val body = unb64(bodyBase64)
        val plaintext = signalCall("decrypt(type=$type, from=$userId.$deviceId)") {
          when (type) {
            CiphertextMessage.PREKEY_TYPE -> cipher.decrypt(PreKeySignalMessage(body))
            CiphertextMessage.WHISPER_TYPE -> cipher.decrypt(SignalMessage(body))
            else -> throw CodedException("UnsupportedMessageType", "Unsupported type $type", null)
          }
        }
        b64(plaintext)
      }
    }

    AsyncFunction("signWithIdentity") { payloadBase64: String ->
      synchronized(lock) {
        b64(requireStore().identityKeyPair.privateKey.calculateSignature(unb64(payloadBase64)))
      }
    }

    AsyncFunction("verifyWithIdentity") {
      payloadBase64: String, signatureBase64: String, identityKey: String ->
      IdentityKey(unb64(identityKey)).publicKey
        .verifySignature(unb64(payloadBase64), unb64(signatureBase64))
    }

    /**
     * RFC 9180 HPKE recovery envelope for nearby/offline delivery — the same
     * libsignal primitive iOS calls (`publicKey.seal`), so at matching
     * versions the wire bytes are identical by construction rather than by
     * agreement. Stateless on purpose: two phones that know each other's
     * published identity keys can recover while offline when a ratchet has
     * been marked for rebuild.
     */
    AsyncFunction("sealToIdentity") {
      plaintextBase64: String, identityKey: String, info: String, associatedDataBase64: String ->
      b64(
        IdentityKey(unb64(identityKey)).publicKey
          .seal(unb64(plaintextBase64), info, unb64(associatedDataBase64)),
      )
    }

    AsyncFunction("openWithIdentity") {
      ciphertextBase64: String, info: String, associatedDataBase64: String ->
      synchronized(lock) {
        b64(
          requireStore().identityKeyPair.privateKey
            .open(unb64(ciphertextBase64), info, unb64(associatedDataBase64)),
        )
      }
    }

    /**
     * Destroys all Signal state. Revocation (doc 31 §3.7) and account deletion
     * (doc 28) — stale sessions would otherwise keep decrypting a revoked
     * peer's ciphertext.
     */
    AsyncFunction("wipe") {
      synchronized(lock) {
        runCatching { requireStore().wipe() }
        secrets().removeAll()
        store = null
        localAddress = null
      }
    }
  }
}
