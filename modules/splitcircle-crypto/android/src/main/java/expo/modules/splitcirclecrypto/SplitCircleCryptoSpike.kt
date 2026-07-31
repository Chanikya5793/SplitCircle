package expo.modules.splitcirclecrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore
import org.signal.libsignal.protocol.util.KeyHelper

/**
 * PHASE 1 LINKAGE SPIKE ONLY (ai_layer/docs/33 §3). Not the real module.
 *
 * Answers the one question that would invalidate doc 33's schedule: does
 * libsignal's Android artifact resolve, link, load its native library, and
 * actually execute a Signal session on real hardware?
 *
 * It performs a FULL PQXDH handshake plus a Double Ratchet round-trip rather
 * than printing a version string. CLAUDE.md's LibSignalClient entry is the
 * standing warning: on iOS that pod compiled, archived and uploaded green
 * while being fundamentally mislinked, and only failed at dyld on a device.
 * "It builds" proves nothing — this forces the .so to load and real
 * cryptographic work to happen.
 *
 * Delete when the real 13-function module lands.
 */
class SplitCircleCryptoSpike : Module() {
  override fun definition() = ModuleDefinition {
    Name("SplitCircleCryptoSpike")

    /**
     * Two independent in-memory stores (Alice, Bob), a real PQXDH handshake
     * from Bob's prekey bundle, encrypt on Alice, decrypt on Bob, assert the
     * plaintext survived. Returns a stage list so a failure names where it
     * broke instead of surfacing a bare exception.
     */
    AsyncFunction("selfTest") {
      val stages = mutableListOf<String>()
      try {
        // Any key generation forces the JNI library to load. A missing .so for
        // this ABI fails HERE, not somewhere ambiguous later.
        stages.add("loadNativeLibrary")
        val aliceIdentity = IdentityKeyPair.generate()

        stages.add("generateBobIdentity")
        val bobIdentity = IdentityKeyPair.generate()
        val bobRegistrationId = KeyHelper.generateRegistrationId(false)

        stages.add("generateBobPreKeys")
        val bobPreKey = ECKeyPair.generate()
        val bobSignedPreKey = ECKeyPair.generate()
        val bobSignedPreKeySignature = bobIdentity.privateKey
          .calculateSignature(bobSignedPreKey.publicKey.serialize())

        // PQXDH is not optional in this libsignal: PreKeyBundle's only public
        // constructor takes a Kyber key + signature. That matches the app's
        // existing PublishableBundle type, which already carries
        // kyberPreKeyId/Public/Signature.
        stages.add("generateKyberPreKey")
        val bobKyber = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
        val bobKyberSignature = bobIdentity.privateKey
          .calculateSignature(bobKyber.publicKey.serialize())

        stages.add("buildStores")
        val aliceStore = InMemorySignalProtocolStore(
          aliceIdentity,
          KeyHelper.generateRegistrationId(false),
        )
        val bobStore = InMemorySignalProtocolStore(bobIdentity, bobRegistrationId)
        val bobAddress = SignalProtocolAddress("bob-device", 1)
        val aliceAddress = SignalProtocolAddress("alice-device", 1)

        stages.add("assemblePreKeyBundle")
        val bobBundle = PreKeyBundle(
          bobRegistrationId,
          1,
          31337,
          bobPreKey.publicKey,
          22,
          bobSignedPreKey.publicKey,
          bobSignedPreKeySignature,
          bobIdentity.publicKey,
          77,
          bobKyber.publicKey,
          bobKyberSignature,
        )

        stages.add("bobPersistsPreKeys")
        bobStore.storePreKey(31337, PreKeyRecord(31337, bobPreKey))
        bobStore.storeSignedPreKey(
          22,
          SignedPreKeyRecord(22, System.currentTimeMillis(), bobSignedPreKey, bobSignedPreKeySignature),
        )
        bobStore.storeKyberPreKey(
          77,
          KyberPreKeyRecord(77, System.currentTimeMillis(), bobKyber, bobKyberSignature),
        )

        // ⚠️ THESE TWO CLASSES TAKE ADDRESSES IN OPPOSITE ORDERS at 0.99.1:
        //   SessionBuilder(store, REMOTE, LOCAL)
        //   SessionCipher (store, LOCAL,  REMOTE)
        // Both compile either way (same types), so getting it wrong fails at
        // runtime, not build time. Verified against the v0.99.1 sources.
        stages.add("pqxdhHandshake")
        SessionBuilder(aliceStore, bobAddress, aliceAddress).process(bobBundle)

        stages.add("encrypt")
        val plaintext = "manasplit-android-linkage-spike"
        val ciphertext = SessionCipher(aliceStore, aliceAddress, bobAddress)
          .encrypt(plaintext.toByteArray(Charsets.UTF_8))
        val ciphertextType = ciphertext.type

        stages.add("decrypt")
        val decrypted = SessionCipher(bobStore, bobAddress, aliceAddress)
          .decrypt(PreKeySignalMessage(ciphertext.serialize()))
        val recovered = String(decrypted, Charsets.UTF_8)

        stages.add("verify")
        mapOf(
          "ok" to (recovered == plaintext),
          "recovered" to recovered,
          "ciphertextType" to ciphertextType,
          "libsignalVersion" to "0.99.1-from-source",
          "stagesCompleted" to stages,
        )
      } catch (t: Throwable) {
        mapOf(
          "ok" to false,
          "failedAtStage" to (stages.lastOrNull() ?: "start"),
          "stagesCompleted" to stages,
          "error" to (t::class.java.name + ": " + (t.message ?: "no message")),
        )
      }
    }
  }
}
