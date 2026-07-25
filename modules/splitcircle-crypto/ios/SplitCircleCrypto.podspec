Pod::Spec.new do |s|
  s.name           = 'SplitCircleCrypto'
  s.version        = '1.0.0'
  s.summary        = 'End-to-end message encryption for SplitCircle (libsignal)'
  s.description    = 'Wraps the official libsignal Swift bindings (doc 31 §3.3). Currently a Phase 3 gate-2 spike — proves LibSignalClient links and runs inside this repo\'s Expo-module pattern; real session/key-management logic lands only after this is verified on a real build.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Pinned, not floated: LibSignalClient's podspec script_phases fetch a
  # prebuilt archive from build-artifacts.signal.org keyed to this exact
  # version + checksum (verified directly against signalapp/libsignal's
  # real podspec during the Phase 3 spike, doc 31 §5) — a floating version
  # would silently break that fetch.
  s.dependency 'LibSignalClient', '0.99.1'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # LibSignalClient's own podspec exposes its internal SignalFfi clang
    # module (swift/Sources/SignalFfi) to ITSELF via these same two xcconfig
    # keys, with the comment "make sure the search path is passed on to
    # Swift dependencies" — but that propagation apparently doesn't reach a
    # separate consuming pod's own Swift compilation automatically (found via
    # a real build during the Phase 3 spike: `import LibSignalClient` alone,
    # with no explicit `import SignalFfi`, still failed with "Unable to
    # resolve module dependency: 'SignalFfi'" without this). Any future pod
    # in this repo that depends on LibSignalClient will need the same fix.
    'HEADER_SEARCH_PATHS' => '$(PODS_ROOT)/LibSignalClient/swift/Sources/SignalFfi',
    'SWIFT_INCLUDE_PATHS' => '$(HEADER_SEARCH_PATHS)',
  }

  # libsignal_ffi.a must be linked by the APP target, not by any pod target.
  #
  # LibSignalClient's own podspec links its fetched Rust FFI archive via
  # `pod_target_xcconfig => { OTHER_LDFLAGS => $(LIBSIGNAL_FFI_LIB_TO_LINK) }`,
  # and ships an EMPTY `user_target_xcconfig`. That works only when the pod is
  # built as a dynamic framework (its own link step then absorbs the archive).
  # This project builds every pod statically (`use_frameworks! :linkage =>
  # :static` — forced by ExpoModulesCore/ExpoModulesJSI, which set
  # static_framework=true and trip CocoaPods'
  # verify_no_static_framework_transitive_dependencies validator under a
  # dynamic default). A static framework target is assembled by libtool/ar,
  # which NEVER invokes `ld`, so OTHER_LDFLAGS there is silently discarded and
  # libsignal_ffi.a is never linked by anything — the final app link then fails
  # with hundreds of undefined `_signal_*` symbols (doc 31 §5 Phase 3 gate 2).
  #
  # `user_target_xcconfig` is merged into the aggregate `Pods-SplitCircle.*
  # .xcconfig`, i.e. it reaches the app target — the one build step in the
  # whole workspace that really runs `ld`. Defining the archive's location
  # there resolves those symbols at the correct link step while every pod
  # stays static, which also avoids the embed/rpath failure mode that broke
  # build 0.0.156 (see the matching note in ios/Podfile's post_install).
  #
  # These are DEFINITIONS ONLY — deliberately no OTHER_LDFLAGS here. Linking a
  # static archive is ORDER-DEPENDENT (`ld` pulls only those members that
  # resolve an already-undefined symbol, and it does not re-scan), so
  # libsignal_ffi.a must appear AFTER `-framework "LibSignalClient"`, whose
  # objects are what reference `_signal_*`. CocoaPods sorts the tokens it
  # merges into the aggregate xcconfig's OTHER_LDFLAGS — an OTHER_LDFLAGS set
  # here landed BEFORE `-framework "LibSignalClient"` (verified in the
  # generated Pods-SplitCircle.release.xcconfig), which would link nothing and
  # fail exactly as before. The flag itself is therefore applied in ios/
  # Podfile's post_install, directly on the app target, where `$(inherited)`
  # expands to this xcconfig's flags first and guarantees correct ordering.
  #
  # PATH RECONSTRUCTION: LibSignalClient resolves the archive as
  # `$(LIBSIGNAL_FFI_TEMP_DIR)/target/$(CARGO_BUILD_TARGET)/release/libsignal_ffi.a`
  # with `LIBSIGNAL_FFI_TEMP_DIR = $(PROJECT_TEMP_DIR)/libsignal_ffi`. That
  # cannot be reused verbatim from the app target: PROJECT_TEMP_DIR is
  # PER-PROJECT (`$(PROJECT_TEMP_ROOT)/$(PROJECT_NAME).build`), so it points at
  # SplitCircle.build here but the extract script phase writes it under
  # Pods.build. PROJECT_TEMP_ROOT is workspace-wide, so `$(PROJECT_TEMP_ROOT)/
  # Pods.build/libsignal_ffi` names the same directory from either project.
  # The CARGO_BUILD_TARGET conditionals must be duplicated for the same
  # reason — they live in LibSignalClient's pod_target_xcconfig and are not
  # visible to the app target. Triples verified against the real prebuilt
  # archive's contents (target/{aarch64-apple-ios-sim,aarch64-apple-ios,
  # x86_64-apple-ios}/release/libsignal_ffi.a). Keep both in sync with
  # LibSignalClient's podspec if its pinned version is ever bumped.
  s.user_target_xcconfig = {
    'CARGO_BUILD_TARGET[sdk=iphonesimulator*][arch=arm64]' => 'aarch64-apple-ios-sim',
    'CARGO_BUILD_TARGET[sdk=iphonesimulator*][arch=*]' => 'x86_64-apple-ios',
    'CARGO_BUILD_TARGET[sdk=iphoneos*][arch=arm64e]' => 'arm64e-apple-ios',
    'CARGO_BUILD_TARGET[sdk=iphoneos*]' => 'aarch64-apple-ios',
    'LIBSIGNAL_FFI_TEMP_DIR' => '$(PROJECT_TEMP_ROOT)/Pods.build/libsignal_ffi',
    'LIBSIGNAL_FFI_LIB_TO_LINK' => '$(LIBSIGNAL_FFI_TEMP_DIR)/target/$(CARGO_BUILD_TARGET)/release/libsignal_ffi.a',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
