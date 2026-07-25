import ExpoModulesCore
import LibSignalClient

/// Phase 3 gate-2 spike (doc 31 §5). ONE function, calling ONE real
/// libsignal API, to prove the LibSignalClient pod actually links and runs
/// inside this repo's New-Architecture + STATIC-framework build — not to
/// do anything useful yet. Real per-device identity/session/store logic is
/// deliberately NOT here; it lands only once this spike is verified on a
/// real build (gate 2 in doc 31's hard-gated sequence).
///
/// NOTE: nothing in the app calls this yet, so it is effectively dead code
/// at runtime. Linking is verified (826 `_signal_*` symbols resolved into
/// the app binary, 0 undefined); actually EXECUTING this function is still
/// unverified — see doc 31 §5 Phase 3.
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
