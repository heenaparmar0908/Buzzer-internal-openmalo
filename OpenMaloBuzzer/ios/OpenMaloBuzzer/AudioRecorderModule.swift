import Foundation
import AVFoundation
import React

@objc(AudioRecorderModule)
class AudioRecorderModule: NSObject {
  private var audioRecorder: AVAudioRecorder?
  private var recordingPath: String?

  @objc
  func startRecording(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
      try session.setActive(true)
    } catch {
      reject("RECORDING_ERROR", "Failed to configure audio session: \(error.localizedDescription)", error)
      return
    }

    let dir = FileManager.default.temporaryDirectory
    let fileName = "vm_\(Int(Date().timeIntervalSince1970 * 1000)).m4a"
    let fileURL = dir.appendingPathComponent(fileName)
    recordingPath = fileURL.path

    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 44100,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      AVEncoderBitRateKey: 128000,
    ]

    do {
      audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
      audioRecorder?.record()
      resolve(recordingPath)
    } catch {
      reject("RECORDING_ERROR", "Failed to start recording: \(error.localizedDescription)", error)
    }
  }

  @objc
  func stopRecording(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    audioRecorder?.stop()
    audioRecorder = nil
    resolve(recordingPath)
  }

  @objc
  static func requiresMainQueueSetup() -> Bool { return false }
}
