Pod::Spec.new do |s|
  s.name           = 'SplitCircleBle'
  s.version        = '1.0.0'
  s.summary        = 'Cross-platform BLE transport for ManaSplit offline messaging'
  s.description    = 'CoreBluetooth central + peripheral. The only nearby link that can reach Android, since MultipeerConnectivity cannot (doc 33 §0). Fragmentation and reassembly live in TypeScript so this half and the Kotlin half cannot drift.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
