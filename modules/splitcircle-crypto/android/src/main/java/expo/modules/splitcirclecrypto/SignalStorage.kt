package expo.modules.splitcirclecrypto

import android.content.Context
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Persistence primitives for the Signal protocol stores — the Android mirror of
 * `ios/SignalStorage.swift` (doc 31 §3.3, doc 33 Phase 1).
 *
 * Two tiers, split the same way iOS splits them:
 *
 * - [SignalSecretStore] — the long-lived device secret (identity keypair,
 *   registration id, libsignal device id). Small, written once, and the single
 *   most sensitive material held here.
 * - [SignalBlobStore] — everything libsignal mutates as messages flow (sessions,
 *   prekeys, sender keys). ONE FILE PER RECORD, because a Signal session is
 *   rewritten on *every* message and a single-blob store would mean rewriting
 *   the entire corpus per message.
 *
 * Everything lives under [Context.getNoBackupFilesDir], the direct Android
 * equivalent of iOS's `isExcludedFromBackup`. This is deliberate and matches
 * iOS's `ThisDeviceOnly` identity key: Signal state is reconstructible only by
 * re-pairing, and a restored backup must NOT resurrect half a Signal store —
 * a clone that inherited this device's identity would break the per-device
 * identity model, and one that inherited sessions without the identity key
 * would hold sessions it can never decrypt.
 *
 * Deliberately NOT SQLite, matching the iOS reasoning: CLAUDE.md flags an
 * unverified linker risk between system libsqlite3 and expo-sqlite's vendored
 * static copy. Plain files avoid the question.
 */

/** Root for all Signal state. Excluded from backup by construction. */
private fun signalRoot(context: Context): File =
  File(context.noBackupFilesDir, "signal").apply { mkdirs() }

/**
 * File-backed `String -> ByteArray` store for libsignal's mutable records.
 *
 * Filenames are the hex of the UTF-8 key. libsignal keys embed user ids and
 * device ids; hex is collision-free, safe on case-insensitive filesystems, and
 * avoids `/`, `:` and Unicode-normalisation surprises that would silently alias
 * two distinct addresses onto one file.
 */
class SignalBlobStore(context: Context, namespace: String) {
  private val root: File = File(signalRoot(context), namespace).apply { mkdirs() }
  private val lock = ReentrantLock()

  private fun fileFor(key: String): File =
    File(root, key.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) })

  fun get(key: String): ByteArray? = lock.withLock {
    val f = fileFor(key)
    if (f.exists()) runCatching { f.readBytes() }.getOrNull() else null
  }

  /**
   * Write-to-temp-then-rename, never write-in-place. A session record is
   * rewritten on every single message; a crash or kill midway through a direct
   * write leaves a truncated record, and a corrupt session cannot be recovered
   * without re-pairing — every message from that peer would fail to decrypt.
   * Rename is atomic on the same filesystem, so a reader sees either the old
   * record or the new one.
   */
  fun set(key: String, value: ByteArray) = lock.withLock {
    val target = fileFor(key)
    val tmp = File(root, "${target.name}.tmp")
    tmp.writeBytes(value)
    if (!tmp.renameTo(target)) {
      // renameTo can fail if the target exists on some filesystems.
      target.delete()
      if (!tmp.renameTo(target)) {
        tmp.delete()
        throw IllegalStateException("Failed to persist Signal record")
      }
    }
  }

  fun delete(key: String) = lock.withLock { fileFor(key).delete(); Unit }

  fun has(key: String): Boolean = lock.withLock { fileFor(key).exists() }

  /** Every key in this namespace, decoded back from its hex filename. */
  fun keys(): List<String> = lock.withLock {
    (root.listFiles() ?: emptyArray())
      .filter { !it.name.endsWith(".tmp") }
      .mapNotNull { f ->
        runCatching {
          String(
            f.name.chunked(2).map { it.toInt(16).toByte() }.toByteArray(),
            Charsets.UTF_8,
          )
        }.getOrNull()
      }
  }

  /**
   * Wipes every record in this namespace. Used by device revocation (doc 31
   * §3.4/§3.7) and account deletion (doc 28), where leaving stale sessions
   * behind would let a revoked peer's ciphertext still decrypt.
   */
  fun removeAll() = lock.withLock {
    (root.listFiles() ?: emptyArray()).forEach { it.delete() }
  }
}

/**
 * The device's long-lived Signal secret.
 *
 * iOS keeps this in the Keychain. Android's closest equivalent with the same
 * properties (device-bound, not in any cloud backup) is app-private storage
 * under `noBackupFilesDir`, which is what this uses. On Android 10+ file-based
 * encryption protects it at rest, and the app sandbox prevents other apps from
 * reading it.
 *
 * KNOWN GAP, recorded rather than glossed: iOS additionally gets Keychain
 * hardening, whereas this is a plain app-private file. Wrapping it with an
 * Android Keystore key (via `androidx.security:security-crypto`) would close
 * that and is worth doing before Android ships — see doc 33. It is NOT done
 * here because that library is on a deprecation track and adding it to the
 * most critical module in the app deserves its own decision.
 */
class SignalSecretStore(context: Context) {
  private val store = SignalBlobStore(context, "identity")

  fun get(key: String): ByteArray? = store.get(key)
  fun set(key: String, value: ByteArray) = store.set(key, value)
  fun has(key: String): Boolean = store.has(key)
  fun removeAll() = store.removeAll()

  companion object {
    const val IDENTITY_KEY_PAIR = "identityKeyPair"
    const val REGISTRATION_ID = "registrationId"
    const val DEVICE_ID = "deviceId"
    const val USER_ID = "userId"
  }
}
