import ExpoModulesCore
import LibSignalClient

/// Phase 3 gate-2 spike (doc 31 §5). ONE function, calling ONE real
/// libsignal API, to prove the LibSignalClient pod actually links and runs
/// inside this repo's New-Architecture + STATIC-framework build — not to
/// do anything useful yet. Real per-device identity/session/store logic is
/// deliberately NOT here; it lands only once this spike is verified on a
/// real build (gate 2 in doc 31's hard-gated sequence).
///
/// VERIFIED 2026-07-25 on a physical iPhone 17 Pro (Release build, device
/// arm64): this function ran and returned a real 69-byte serialized keypair.
/// Nothing in the app calls it, so it is dead code at runtime — kept only as
/// the executable proof that the libsignal toolchain works end-to-end. Delete
/// it once real key management lands.
///
/// Gotcha found while verifying: a Release build's JS `console.error` does NOT
/// reach the device log, so JS-side probes are invisible there. Use `NSLog`
/// from native (or write to the app container) when instrumenting a Release
/// build on a real device.
public class SplitCircleCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SplitCircleCrypto")

    AsyncFunction("spikeGenerateIdentityKeyPair") { () -> String in
      let identity = IdentityKeyPair.generate()
      let serialized = identity.serialize()
      return Data(serialized).base64EncodedString()
    }
  }
}
