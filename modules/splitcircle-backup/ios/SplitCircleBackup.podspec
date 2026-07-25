Pod::Spec.new do |s|
  s.name           = 'SplitCircleBackup'
  s.version        = '1.0.0'
  s.summary        = 'iCloud (CloudKit) chat backup/restore for SplitCircle'
  s.description    = 'Main-device-only bulk export to CloudKit and new-main-device-only bulk import from it (doc 31 §3.2). Deliberately NOT CKSyncEngine — see BackupProvider.swift doc comment.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
