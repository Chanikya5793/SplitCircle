Pod::Spec.new do |s|
  s.name           = 'SplitCircleMedia'
  s.version        = '1.0.0'
  s.summary        = 'iCloud-aware Photos access for SplitCircle chat media'
  s.description    = 'Picks PHAssets by identifier without materializing files, and streams originals off iCloud with real progress and cancellation. Exists because expo-image-picker downloads every selected asset synchronously inside the picker call, with no progress handler and no way to cancel.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
