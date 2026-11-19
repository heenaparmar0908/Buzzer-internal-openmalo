import Foundation
import CallKit
import PushKit
import UIKit

/// CallKit + PushKit integration for WhatsApp-style incoming buzz delivery.
///
/// WHY THIS EXISTS:
///   Regular APNs notifications can be delayed or throttled by iOS after long
///   inactivity. PushKit VoIP pushes are GUARANTEED delivery — iOS wakes the
///   app immediately, even if it was killed by the user. This is how WhatsApp
///   achieves reliable incoming call delivery.
///
/// HOW IT WORKS:
///   1. PushKit registers for VoIP pushes → gets a separate voip_token
///   2. Server sends VoIP push when a buzz is created
///   3. iOS wakes the app (even if killed) and calls didReceiveIncomingPush
///   4. We MUST report a CXCallUpdate to CallKit within seconds (iOS 13+ requirement)
///   5. iOS shows the native incoming call screen (green/red buttons)
///   6. User answers → we open IncomingBuzzScreen with full alarm
///   7. User declines → we respond with "busy"
///
/// IMPORTANT: Apple REQUIRES that every VoIP push results in a CallKit call
/// being reported. If you receive a VoIP push and don't report a call, iOS
/// will terminate your app and may block future VoIP pushes.
class BuzzerCallManager: NSObject {

  static let shared = BuzzerCallManager()

  private let provider: CXProvider
  private let callController = CXCallController()
  private var voipRegistry: PKPushRegistry?

  /// Currently active buzz call UUID (nil if no active buzz)
  private(set) var activeCallUUID: UUID?
  private var activeBuzzData: [String: String] = [:]

  private override init() {
    let config = CXProviderConfiguration()
    config.localizedName = "Buzzer"
    config.supportsVideo = false
    config.maximumCallsPerCallGroup = 1
    config.maximumCallGroups = 1
    // Use the app's buzz sound for the ringtone
    config.ringtoneSound = "buzz_alarm.wav"
    // Show the app icon in the call screen
    if let iconImage = UIImage(named: "AppIcon") {
      config.iconTemplateImageData = iconImage.pngData()
    }
    config.supportedHandleTypes = [.generic]

    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  // MARK: - PushKit VoIP Registration

  /// Start listening for VoIP pushes. Call this from AppDelegate.didFinishLaunching.
  func registerForVoIPPushes() {
    voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
    voipRegistry?.delegate = self
    voipRegistry?.desiredPushTypes = [.voIP]
  }

  // MARK: - Report Incoming Buzz

  /// Called when a VoIP push arrives or when we want to show the system call UI.
  func reportIncomingBuzz(
    buzzId: String,
    fromUserName: String,
    reason: String,
    fromUserId: String = "",
    note: String = "",
    soundId: String = "buzz_alarm",
    completion: ((Error?) -> Void)? = nil
  ) {
    let uuid = UUID()
    activeCallUUID = uuid
    activeBuzzData = [
      "buzz_id": buzzId,
      "from_user_id": fromUserId,
      "from_user_name": fromUserName,
      "reason": reason,
      "note": note,
      "sound_id": soundId,
    ]

    let update = CXCallUpdate()
    update.localizedCallerName = "\(fromUserName) — \(reason)"
    update.remoteHandle = CXHandle(type: .generic, value: buzzId)
    update.hasVideo = false
    update.supportsDTMF = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false

    provider.reportNewIncomingCall(with: uuid, update: update) { error in
      if let error = error {
        print("[CallKit] Failed to report incoming call: \(error.localizedDescription)")
        self.activeCallUUID = nil
        self.activeBuzzData = [:]
      } else {
        print("[CallKit] Incoming buzz reported: \(buzzId)")
        // Auto-end after 2 minutes (matches Android auto-dismiss)
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in
          guard let self = self, self.activeCallUUID == uuid else { return }
          self.endCall(reason: .unanswered)
        }
      }
      completion?(error)
    }
  }

  /// End the current buzz call.
  func endCall(reason: CXCallEndedReason = .remoteEnded) {
    guard let uuid = activeCallUUID else { return }
    provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
    activeCallUUID = nil
    activeBuzzData = [:]
  }

  /// Get the VoIP push token (for sending to server).
  var voipToken: String? {
    guard let tokenData = voipRegistry?.pushToken(for: .voIP) else { return nil }
    return tokenData.map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - CXProviderDelegate

extension BuzzerCallManager: CXProviderDelegate {

  func providerDidReset(_ provider: CXProvider) {
    print("[CallKit] Provider reset")
    activeCallUUID = nil
    activeBuzzData = [:]
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    print("[CallKit] Call answered — opening IncomingBuzzScreen")

    // Open the app to IncomingBuzzScreen
    let buzzData = activeBuzzData
    DispatchQueue.main.async {
      // Post a notification that the React Native bridge can observe
      NotificationCenter.default.post(
        name: NSNotification.Name("BuzzerCallAnswered"),
        object: nil,
        userInfo: buzzData
      )
    }

    action.fulfill()

    // End the CallKit call after a brief delay (the alarm continues via BuzzerAlarmModule)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      self?.endCall(reason: .answeredElsewhere)
    }
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    print("[CallKit] Call ended/rejected")

    let buzzId = activeBuzzData["buzz_id"] ?? ""
    if !buzzId.isEmpty {
      // Respond with "busy" via Supabase REST (native, no JS bridge needed)
      respondToBuzz(buzzId: buzzId, response: "busy")
    }

    activeCallUUID = nil
    activeBuzzData = [:]
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    print("[CallKit] Audio session activated")
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    print("[CallKit] Audio session deactivated")
  }

  // MARK: - Native Supabase response (no JS bridge needed)

  private func respondToBuzz(buzzId: String, response: String) {
    guard let supabaseUrl = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String,
          let supabaseKey = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String,
          let url = URL(string: "\(supabaseUrl)/rest/v1/buzzes?id=eq.\(buzzId)&response=eq.none") else {
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "PATCH"
    request.setValue(supabaseKey, forHTTPHeaderField: "apikey")
    request.setValue("Bearer \(supabaseKey)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
    request.timeoutInterval = 10

    let body: [String: Any] = [
      "response": response,
      "responded_at": Int64(Date().timeIntervalSince1970 * 1000),
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: request).resume()
  }
}

// MARK: - PKPushRegistryDelegate (VoIP Push)

extension BuzzerCallManager: PKPushRegistryDelegate {

  func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    guard type == .voIP else { return }
    let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    print("[PushKit] VoIP token: \(token.prefix(20))...")

    // Store locally — JS side will read and send to server
    UserDefaults.standard.set(token, forKey: "buzzer_voip_token")

    // Also save to Supabase directly (in case JS bridge is not ready)
    saveVoIPTokenToSupabase(token: token)
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else { completion(); return }

    let data = payload.dictionaryPayload
    let buzzId = data["buzz_id"] as? String ?? ""
    let fromUserName = data["from_user_name"] as? String ?? "User"
    let reason = data["reason"] as? String ?? "Incoming buzz"
    let fromUserId = data["from_user_id"] as? String ?? ""
    let note = data["note"] as? String ?? ""
    let soundId = data["sound_id"] as? String ?? "buzz_alarm"

    print("[PushKit] VoIP push received: buzz=\(buzzId) from=\(fromUserName)")

    // MUST report a CallKit call immediately (iOS 13+ requirement).
    // If we don't, iOS will terminate the app and may block future VoIP pushes.
    reportIncomingBuzz(
      buzzId: buzzId,
      fromUserName: fromUserName,
      reason: reason,
      fromUserId: fromUserId,
      note: note,
      soundId: soundId
    ) { _ in
      completion()
    }
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didInvalidatePushTokenFor type: PKPushType
  ) {
    guard type == .voIP else { return }
    print("[PushKit] VoIP token invalidated")
    UserDefaults.standard.removeObject(forKey: "buzzer_voip_token")
  }

  // MARK: - Save VoIP token to Supabase

  private func saveVoIPTokenToSupabase(token: String) {
    guard let userId = UserDefaults.standard.string(forKey: "buzzer_active_user_id"),
          let supabaseUrl = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String,
          let supabaseKey = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String,
          let url = URL(string: "\(supabaseUrl)/rest/v1/user_tokens?user_id=eq.\(userId)") else {
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "PATCH"
    request.setValue(supabaseKey, forHTTPHeaderField: "apikey")
    request.setValue("Bearer \(supabaseKey)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
    request.timeoutInterval = 10

    let body: [String: Any] = [
      "voip_token": token,
      "token_updated_at": Int64(Date().timeIntervalSince1970 * 1000),
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: request).resume()
  }
}
