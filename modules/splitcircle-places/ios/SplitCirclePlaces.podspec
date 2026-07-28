Pod::Spec.new do |s|
  s.name           = 'SplitCirclePlaces'
  s.version        = '1.0.0'
  s.summary        = 'MapKit-backed place search for SplitCircle'
  s.description    = 'MKLocalSearch wrapper. Expo Location only forward-geocodes addresses, which cannot find businesses or landmarks; this is what the Apple Maps search field itself uses.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
