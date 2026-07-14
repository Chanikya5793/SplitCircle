Pod::Spec.new do |s|
  s.name           = 'SplitCircleAI'
  s.version        = '1.0.0'
  s.summary        = 'On-device AI helpers for SplitCircle (PII redaction, Siri donation)'
  s.description    = 'NSDataDetector-based PII redaction before AI queries leave the device, and NSUserActivity donation for the Ask-SplitCircle flow.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # System sqlite3 (dylib), for SplitCircleIndexReader.swift's read-only bridge into
  # the ai_index.db file expo-sqlite writes. NOTE: expo-sqlite vendors its OWN static
  # copy of sqlite3.c (unprefixed symbol names — see node_modules/expo-sqlite/ios/
  # sqlite3.h, SQLITE_API is a no-op macro there). Linking the system dylib here is
  # deliberate and should NOT collide: dylib symbol tables resolve at load time and
  # don't conflict with another pod's statically-archived sqlite3.o the way two
  # static archives defining the same symbol would. This is unverified by an actual
  # build in this environment — the first `pod install` + Xcode build after adding
  # this must be checked for a duplicate-symbol linker error before trusting it.
  s.library = 'sqlite3'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
