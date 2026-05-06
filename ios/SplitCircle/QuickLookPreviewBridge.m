//
//  QuickLookPreviewBridge.m
//  SplitCircle
//
//  Objective-C bridge to expose QuickLookPreview Swift module to React Native.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(QuickLookPreview, NSObject)

RCT_EXTERN_METHOD(previewFile:(NSString *)uri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
