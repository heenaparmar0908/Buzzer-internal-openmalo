#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AudioRecorderModule, NSObject)

RCT_EXTERN_METHOD(startRecording:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopRecording:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)

@end
