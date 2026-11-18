# OpenMalo Buzzer - Incoming Buzz QA Test Matrix

## Architecture Assumptions (Based on Codebase)

| Component | Implementation |
|---|---|
| Framework | React Native 0.87.1 |
| Push (Android) | FCM v1 API, data-only messages, high priority |
| Push (iOS) | FCM -> APNs, notification messages with `aps.alert` + sound |
| Realtime | Supabase Realtime (PostgreSQL CDC over WebSocket) |
| Android service | `BuzzerService` Kotlin foreground service (dataSync type), polls Supabase REST every 10s |
| iOS background | No persistent service. Relies on APNs + `checkPending` on app open |
| Alarm | Android: MediaPlayer USAGE_ALARM + Vibrator. iOS: BuzzerAlarmModule (AVAudioPlayer) |
| Token storage | `user_tokens` table in Supabase (fcm_token, platform, fcm_token_stale, token_updated_at) |
| Edge function | `send-notification` Deno function, JWT-signed FCM v1 API calls |
| Auto-dismiss | 2 min timeout -> `auto_dismissed` (native service) or `dismissed` (JS-side IncomingBuzzScreen) |
| Recovery | `checkPending` on every app open queries `response IN ('none','auto_dismissed')` with no time limit |
| Auth | PIN-based, stored in AsyncStorage. Supabase anon key (no session expiry) |

## Delivery Paths (Redundancy Layers)

| # | Path | When active | Latency |
|---|---|---|---|
| 1 | FCM foreground (onMessage) | App in foreground | ~100-500ms |
| 2 | FCM background (setBackgroundMessageHandler) | App backgrounded/killed | ~100-2000ms |
| 3 | Supabase Realtime (WebSocket INSERT) | App in foreground, WS connected | ~200-1000ms |
| 4 | Native polling (BuzzerService, Android only) | Service alive | 0-10s |
| 5 | JS polling (setInterval 5s) | App active in foreground | 0-5s |
| 6 | checkPending (safety net) | Every app open + resume | On open |

---

## SECTION 1: ANDROID TEST CASES

### 1.1 Foreground State

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-FG-01 | Buzz arrives while app is in foreground | App open on home screen, logged in | Send buzz from another device | FCM onMessage fires -> IncomingBuzzScreen shows -> alarm plays at max volume -> vibration starts | Screen visible within 1s, alarm audible, vibration felt | LOW |
| A-FG-02 | Buzz arrives while on another screen (Settings) | App open on Settings screen | Send buzz | IncomingBuzzScreen overlay renders on TOP of Settings | Overlay appears, alarm plays, Settings screen preserved underneath | LOW |
| A-FG-03 | Buzz arrives while already showing a buzz | First buzz showing on IncomingBuzzScreen | Send second buzz from different sender | First buzz stays (dedup by buzz_id). Second buzz queued, shown after first dismissed | No crash, no double-alarm, second buzz appears after first resolved | MEDIUM |
| A-FG-04 | Buzz cancelled while alarm playing | IncomingBuzzScreen showing, alarm active | Sender presses Cancel | Realtime UPDATE fires -> alarm stops -> screen dismisses -> "Buzz cancelled" notification | Alarm stops within 1s of cancellation | LOW |
| A-FG-05 | Buzz in foreground, Realtime dies mid-session | App open, WiFi connected | Disable WiFi briefly, re-enable, send buzz | Realtime reconnects (auto-reconnect on CLOSED/CHANNEL_ERROR). JS polling (5s) or FCM catches it | Buzz arrives within 5s even if Realtime failed | MEDIUM |
| A-FG-06 | Buzz in foreground, DND mode active | App open, DND enabled, DND access NOT granted | Send buzz | Alarm plays on STREAM_ALARM + fallback STREAM_MUSIC. DND may suppress STREAM_ALARM on some OEMs | Sound audible via STREAM_MUSIC fallback. Vibration works | MEDIUM |
| A-FG-07 | Buzz in foreground, phone on silent/vibrate | App open, ringer mode = silent | Send buzz | BuzzerService sets ringer to NORMAL (requires DND access). Alarm plays on STREAM_ALARM | If DND access granted: sound plays. If not: vibration only | MEDIUM |
| A-FG-08 | Buzz in foreground, app muted via in-app toggle | App open, mute toggle ON | Send buzz | IncomingBuzzScreen shows, vibration plays, NO sound (MediaPlayer skipped) | Screen visible, vibration only, no sound | LOW |

### 1.2 Background State

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-BG-01 | Buzz arrives while app is backgrounded | App running, press Home, app in recents | Send buzz | FCM background handler -> BuzzerService.showBuzz() -> notification + alarm | Notification appears as heads-up, alarm audible within 2s | LOW |
| A-BG-02 | Buzz arrives, user taps notification | A-BG-01 completed, notification visible | Tap notification | App opens -> IncomingBuzzScreen shows -> alarm continues from native service | Full-screen buzz UI appears, alarm uninterrupted | LOW |
| A-BG-03 | Buzz arrives, user responds from notification actions | Notification with Ack/5min/Busy buttons visible | Tap "Ack" button on notification | Response sent to Supabase, alarm stops, notification dismissed | Sender sees "Coming" response, alarm stops | LOW |
| A-BG-04 | Buzz auto-dismissed after 2 min in background | Buzz arrived while backgrounded, user ignores for 2 min | Wait 2 minutes | Alarm stops, notification replaced by "Missed buzz from X", response = `auto_dismissed` | Missed notification visible in drawer. When app opens, IncomingBuzzScreen shows (stale, gentle vibrate) | MEDIUM |
| A-BG-05 | Buzz arrives, BuzzerService was killed by OEM | App backgrounded for 30+ min on aggressive OEM | Send buzz | FCM wakes app -> background handler -> BuzzerService.showBuzz() restarts service | Alarm plays, notification shows. Service heartbeat resumes | HIGH - **Real device required** |
| A-BG-06 | Buzz arrives on background with Battery Saver ON | Battery Saver enabled | Send buzz | FCM high-priority bypasses Doze. BuzzerService alarm plays | Notification + alarm within 5s | MEDIUM |
| A-BG-07 | Multiple buzzes while backgrounded | App backgrounded | Send 3 buzzes rapidly from different senders | Each gets notification + alarm. First buzz plays, subsequent buzzes queue (seenBuzzIds dedup) | First alarm plays, others show as notifications. All recoverable on app open | MEDIUM |

### 1.3 Killed State (Swiped from Recents)

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-KILL-01 | Buzz arrives after swipe-kill | Swipe app from recents | Send buzz | FCM data message wakes app process briefly -> background handler -> BuzzerService.showBuzz() | Notification + alarm play. `stopWithTask=false` keeps service alive | MEDIUM |
| A-KILL-02 | Buzz arrives after swipe-kill, service also dead | Swipe-kill + wait 5 min for service to die | Send buzz | FCM wakes app -> background handler -> tries showBuzz(). If service can't start, notifee fallback notification with sound | At minimum: notification with sound. At best: full alarm | HIGH |
| A-KILL-03 | Buzz after swipe-kill, user opens app | A-KILL-01/02 alarm played and auto-dismissed | Open app | checkPending finds `auto_dismissed` buzz -> IncomingBuzzScreen shows with "Sent X ago" + gentle vibrate | Buzz recovered, user can respond | MEDIUM |
| A-KILL-04 | Service restart after swipe-kill | App swiped from recents | Wait 30s, check if service restarts | scheduleRestartAlarm (3s/10s/30s/60s escalating) + WorkManager watchdog (15 min) | Service heartbeat resumes within 60s. If not, within 15 min via WorkManager | MEDIUM |

### 1.4 Force-Stopped State

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-FS-01 | Buzz arrives after Settings -> Force Stop | Force Stop via Android Settings | Send buzz | **NO delivery possible.** FCM blocked, service dead, no restart | Buzz stays `response='none'` in DB. Sender gets push failure alert (if token becomes stale) | **CRITICAL - Platform limitation** |
| A-FS-02 | Recovery after Force Stop | A-FS-01, buzz pending in DB | User manually opens app | checkPending -> finds `response IN ('none','auto_dismissed')` -> IncomingBuzzScreen shows | Buzz recovered on app open | LOW |

### 1.5 Long Inactivity (1-5 Days)

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-LI-01 | Buzz after 1 day inactivity | App not opened for 24h. Service likely dead | Send buzz | FCM high-priority delivers -> background handler -> alarm + notification -> 2 min auto-dismiss -> `auto_dismissed` + "Missed buzz" notification | Missed notification visible. On app open: checkPending recovers | HIGH - **Real device required** |
| A-LI-02 | Buzz after 3 days inactivity | App not opened for 3 days. App in "Rare" standby bucket | Send buzz | FCM high-priority: limited but should deliver (~5/day in Rare bucket). Same flow as A-LI-01 | FCM delivers. If not: sender alert, buzz recovered on app open | HIGH - **Real device required** |
| A-LI-03 | Buzz after 5 days inactivity | App not opened for 5 days | Send buzz | Same as A-LI-02. FCM token still valid (tokens last months). WorkManager may still run occasionally | Same as A-LI-02 | HIGH - **Real device required** |
| A-LI-04 | Buzz after 5 days, FCM token rotated | App not opened for 5 days, Firebase rotated token | Send buzz | Edge function -> FCM returns UNREGISTERED -> sendBuzzPush returns `token_invalid` -> sender alert | Sender sees "push token is invalid" alert. Buzz in DB. Recovery on app open | HIGH |
| A-LI-05 | App opened after 5 days with pending buzzes | Multiple buzzes sent over 5 days, some auto_dismissed, some none | Open app | checkPending finds ALL with `response IN ('none','auto_dismissed')` -> shows newest first. Subsequent buzzes shown on each app resume | All buzzes eventually shown. Stale ones get gentle vibrate + "Sent X ago" label | MEDIUM |
| A-LI-06 | FCM token refresh after long inactivity | App not opened for 5 days | Open app | `refreshFcmToken()` runs in useAuth -> gets new token -> updates Supabase `user_tokens` with `fcm_token_stale=false` | Token refreshed. Future pushes work immediately | LOW |

### 1.6 OEM-Specific (Real Device Required)

| ID | Test Case | OEM | Preconditions | Steps | Expected Result | Risk |
|---|---|---|---|---|---|---|
| A-OEM-01 | Xiaomi/MIUI battery kill | Xiaomi | App NOT in "battery saver exempt" list | Background app for 30 min, send buzz | Service killed. FCM may still deliver (MIUI allows FCM for whitelisted GMS). Watchdog/WorkManager attempts restart | **CRITICAL** - Must test on real Xiaomi |
| A-OEM-02 | Xiaomi with Autostart enabled | Xiaomi | App in Autostart list + battery exempt | Background for 1 hour, send buzz | Service survives or restarts via BootReceiver. Full alarm | HIGH |
| A-OEM-03 | Samsung One UI sleep | Samsung | App in "Sleeping apps" list | Background for 1 hour, send buzz | Samsung limits background activity. FCM should still deliver. Alarm may be suppressed | HIGH - **Real device required** |
| A-OEM-04 | Samsung with "Never sleeping" | Samsung | App in "Never sleeping apps" | Same as A-OEM-03 | Full alarm, no restrictions | MEDIUM |
| A-OEM-05 | Huawei/EMUI aggressive kill | Huawei | No battery exemption | Background for 30 min | Service killed, no restart. FCM delivery unreliable on Huawei (custom push) | **CRITICAL** - Huawei may block FCM entirely |
| A-OEM-06 | Oppo/ColorOS auto-launch | Oppo/Realme | App NOT in auto-launch list | Kill app, send buzz | FCM may deliver but app can't start foreground service. Notifee fallback notification | HIGH - **Real device required** |
| A-OEM-07 | OnePlus battery optimization | OnePlus | Default settings | Background for 2 hours | OnePlus moderately aggressive. FCM usually delivers. Service may die | MEDIUM |

### 1.7 Network Conditions

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-NET-01 | Buzz on WiFi | WiFi connected | Send buzz | Normal delivery via FCM + Realtime | Within 1s | LOW |
| A-NET-02 | Buzz on cellular only | WiFi off, cellular on | Send buzz | FCM delivers over cellular. Supabase REST poll works | Within 2s | LOW |
| A-NET-03 | Buzz during WiFi->cellular handoff | Switch from WiFi to cellular mid-buzz | Send buzz during transition | Realtime WebSocket dies, reconnects. FCM may queue. JS polling catches it | Buzz arrives within 10s | MEDIUM |
| A-NET-04 | Buzz while Data Saver ON | Data Saver enabled | Send buzz | FCM high-priority bypasses Data Saver. Supabase polling may be restricted | FCM delivers. If not, checkPending on resume | MEDIUM |
| A-NET-05 | Buzz while device offline, comes online later | Airplane mode | Send buzz, then disable airplane mode after 1 min | FCM queued at Google servers. Delivered when device comes online. BuzzerService poll catches it | Buzz arrives within 15s of reconnection | MEDIUM |
| A-NET-06 | Buzz after device reboot | Reboot device | Send buzz after boot completes | BootReceiver fires -> starts BuzzerService. FCM reconnects. Buzz delivered | Service starts on boot. Buzz arrives within 30s | MEDIUM |

### 1.8 DND / Focus Modes

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| A-DND-01 | Buzz with DND on, DND access granted | DND active, app has DND policy access | Send buzz | BuzzerService disables DND temporarily -> alarm plays at max volume -> DND restored after alarm stops | Full alarm audible despite DND | LOW |
| A-DND-02 | Buzz with DND on, DND access NOT granted | DND active, no DND policy access | Send buzz | STREAM_ALARM may be suppressed. STREAM_MUSIC fallback plays. Vibration works | At minimum: vibration. Fallback music stream may play | MEDIUM |
| A-DND-03 | Buzz with Bedtime mode | Bedtime/Wind Down active | Send buzz | Same as DND. Buzz channel has `bypassDnd=true` on the visual channel | Notification appears. Alarm depends on DND access | MEDIUM |

---

## SECTION 2: iOS TEST CASES

### 2.1 Foreground State

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| I-FG-01 | Buzz arrives while app is in foreground | App open on home screen | Send buzz | FCM onMessage fires -> setIncomingPayload -> IncomingBuzzScreen -> BuzzerAlarmModule.startAlarm() -> AVAudioPlayer loops | Screen visible, alarm audible (bypasses mute switch via .playback category), vibration | LOW |
| I-FG-02 | Buzz arrives, phone on silent switch | App open, hardware mute switch ON | Send buzz | BuzzerAlarmModule uses `.playback` category -> bypasses mute switch | Alarm audible despite mute switch | LOW |
| I-FG-03 | Buzz cancelled while alarm playing | IncomingBuzzScreen showing | Sender cancels | FCM onMessage `buzz_cancelled` -> stopAlarm -> dismiss screen | Alarm stops within 1s | LOW |
| I-FG-04 | Buzz in foreground, Realtime dies | App open, network fluctuation | Send buzz | Realtime auto-reconnect fires. FCM onMessage delivers. JS polling (5s) backup | Buzz arrives within 5s | MEDIUM |

### 2.2 Background State

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| I-BG-01 | Buzz arrives while app backgrounded | Press Home, app in background | Send buzz | APNs notification with sound (`buzz_alarm.wav`, 29s file). System shows notification with Ack/5min/Busy action buttons | Notification visible + sound plays for up to 29s | LOW |
| I-BG-02 | User taps notification from background | I-BG-01, notification visible | Tap notification | App opens -> onNotificationOpenedApp or notifee PRESS handler -> IncomingBuzzScreen -> BuzzerAlarmModule starts looping alarm | Full-screen UI + continuous alarm | LOW |
| I-BG-03 | User responds from notification actions | I-BG-01, action buttons visible | Tap "Ack" on notification | notifee onBackgroundEvent ACTION_PRESS -> respondToBuzz() -> notification dismissed | Response sent, sender sees it | LOW |
| I-BG-04 | Buzz cancelled while in background | Notification showing | Sender cancels | FCM `buzz_cancelled` -> background handler -> notifee.cancelNotification + shows "Buzz cancelled" notice | Original notification replaced by cancellation notice | MEDIUM |
| I-BG-05 | Background App Refresh disabled | Settings -> General -> Background App Refresh OFF for Buzzer | Send buzz | APNs still delivers (not affected by BAR setting). FCM background handler fires | Notification + sound play normally | LOW |

### 2.3 Killed State (Swiped Up)

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| I-KILL-01 | Buzz arrives after swipe-kill | Swipe app from app switcher | Send buzz | APNs delivers notification (system shows it even with killed app). Sound plays (up to 29s from `aps.sound` field) | Notification visible + system sound plays | LOW |
| I-KILL-02 | User taps notification from killed state | I-KILL-01, notification visible | Tap notification | App cold-starts -> `getInitialNotification()` or notifee `getInitialNotification()` -> IncomingBuzzScreen | Full-screen UI shows. BuzzerAlarmModule starts alarm | MEDIUM |
| I-KILL-03 | User taps notification, buzz already cancelled | I-KILL-01, then sender cancels, then user taps | Tap notification | App opens -> IncomingBuzzScreen checks response -> sees `cancelled` -> onDismiss() | Screen does NOT show for cancelled buzz | LOW |
| I-KILL-04 | Notification tap stores data for killed-state recovery | App killed, notification arrived | Tap notification | notifee onBackgroundEvent PRESS -> stores buzz data in AsyncStorage `@buzzer_pending_tap` -> checkPending reads it on open | Buzz recovered even if Firebase/notifee getInitialNotification fails | MEDIUM |

### 2.4 Long Inactivity (1-5 Days)

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| I-LI-01 | Buzz after 1 day inactivity | App not opened for 24h | Send buzz | APNs token usually still valid. System shows notification + sound | Notification visible. On tap: app opens, IncomingBuzzScreen shows | MEDIUM - **Real device required** |
| I-LI-02 | Buzz after 3 days inactivity | App not opened for 3 days | Send buzz | Same as I-LI-01. APNs tokens are more stable than FCM (rarely expire) | Same as I-LI-01 | MEDIUM |
| I-LI-03 | Buzz after 5 days inactivity | App not opened for 5 days | Send buzz | APNs should still deliver. If token expired: sender gets alert, buzz in DB | Notification shows OR buzz recovered on app open | HIGH - **Real device required** |
| I-LI-04 | App opened after 5 days with pending buzzes | Buzzes sent over 5 days, user never tapped notifications | Open app | checkPending safety-net query finds ALL `response IN ('none','auto_dismissed')` -> shows newest | All pending buzzes shown one by one on subsequent resumes | MEDIUM |
| I-LI-05 | APNs token refresh after long inactivity | App not opened for 5 days | Open app | `refreshFcmToken()` -> Firebase gets new APNs token -> updates Supabase | Token refreshed, future pushes work | LOW |
| I-LI-06 | Notification not tapped, app opened directly | APNs notification in notification center for 2 days. User opens app via icon, not notification | Open app via icon | checkPending -> safety-net query -> finds buzz (`response='none'` since no auto-dismiss on iOS killed state) -> IncomingBuzzScreen | Buzz shown with "Sent 2 days ago" + gentle vibrate | LOW |

### 2.5 iOS-Specific Conditions

| ID | Test Case | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| I-IOS-01 | Low Power Mode enabled | Low Power Mode ON | Send buzz (backgrounded) | APNs still delivers in Low Power Mode. Background fetch may be delayed | Notification visible + sound | LOW |
| I-IOS-02 | Focus mode (Do Not Disturb) | DND/Focus active, Buzzer NOT in allowed apps | Send buzz | Notification silenced by Focus. Buzz in notification center but no banner/sound | Buzz visible when Focus disabled. checkPending recovers on app open | MEDIUM |
| I-IOS-03 | Focus mode with Buzzer allowed | DND/Focus active, Buzzer in allowed apps or `time-sensitive` interruption level | Send buzz | `interruption-level: time-sensitive` in APNs payload -> notification breaks through Focus | Notification + sound play despite Focus | LOW |
| I-IOS-04 | Critical Alerts entitlement (if approved) | Apple Critical Alerts entitlement granted | Send buzz | Critical alert bypasses ALL Focus/DND/mute settings | Full sound even in DND | LOW (pending Apple approval) |
| I-IOS-05 | Notification sounds disabled in iOS Settings | Settings -> Notifications -> Buzzer -> Sounds OFF | Send buzz | Notification appears but NO sound. App detects this on open and shows alert | Alert shown: "Notification Sound Disabled" | MEDIUM |
| I-IOS-06 | Notifications completely disabled | Settings -> Notifications -> Buzzer -> OFF | Send buzz | No notification at all. FCM data still delivered to background handler (returns early on iOS). Buzz in DB | checkPending recovers on app open. No sound/notification until then | HIGH |
| I-IOS-07 | Device reboot, app not launched | Reboot iPhone, don't open app | Send buzz | APNs delivers to system -> notification shown (iOS shows notifications even before first app launch after reboot) | Notification visible after reboot | LOW |

---

## SECTION 3: TOKEN & ACCOUNT CONDITIONS

| ID | Test Case | Platform | Preconditions | Steps | Expected Result | Pass Criteria | Risk |
|---|---|---|---|---|---|---|
| T-01 | Valid token, normal delivery | Both | App recently opened, token fresh | Send buzz | Normal delivery via FCM/APNs | Within 2s | LOW |
| T-02 | Token rotated by Firebase | Both | App not opened for weeks, Firebase rotated token | Send buzz | FCM returns UNREGISTERED -> edge function returns 410 -> sendBuzzPush returns `token_invalid` | Sender alert: "push token is invalid". Buzz in DB, recovered on open | HIGH |
| T-03 | Token stale flag already set | Both | Previous push bounced, `fcm_token_stale=true` in DB | Send buzz | sendBuzzPush returns `token_invalid` immediately (no FCM call made) | Sender alert. Buzz in DB | LOW |
| T-04 | Token refreshed after stale | Both | Token was stale, user opens app | Open app then send buzz | refreshFcmToken() sets `fcm_token_stale=false` + new token. Next push works | Push delivers normally | LOW |
| T-05 | No token in DB (new device, never opened) | Both | User exists but `user_tokens` row missing | Send buzz | sendBuzzPush returns `no_token` | Sender alert: "no push token registered". Buzz in DB | MEDIUM |
| T-06 | User logged out on receiver | Both | Receiver logged out (token deleted from DB) | Send buzz | sendBuzzPush returns `no_token` | Sender alert. Buzz in DB but to_user_id still matches. If user logs back in, checkPending finds it | MEDIUM |
| T-07 | Sender cancels after token failure | Both | sendBuzzPush returned `token_invalid` | Sender taps Cancel | respondToBuzz('cancelled') + sendBuzzCancelledPush (also fails, no token). Buzz set to `cancelled` in DB | Buzz cancelled in DB. Receiver won't see it on open | LOW |
| T-08 | Re-push every 10s with valid token | Both | Sender BuzzSheet open, buzz waiting | Wait 30s | sendBuzzPush called 3 times (10s interval). Each re-push to same token. iOS collapses via `apns-collapse-id`. Android deduped by `seenBuzzIds` | No duplicate alarms. iOS sound restarts on each push | LOW |

---

## SECTION 4: HIGH-RISK CASES (SILENT MESSAGE LOSS)

These are cases where the buzz could be **permanently lost** without either party knowing:

| ID | Scenario | Platform | What Happens | Mitigation in Code | Remaining Risk |
|---|---|---|---|---|---|
| HR-01 | Force-stop + no app open | Android | FCM blocked, no service, no polling. Buzz sits in DB forever | checkPending on next app open (no time limit) | User must open app. **No workaround** |
| HR-02 | FCM "delivered" but device never processes | Both | Google/Apple accept message but device in deep sleep, message expires in queue | Sender sees "delivered" (false positive). JS polling + checkPending on open | Sender unaware. Buzz recovered on open |
| HR-03 | Huawei/Honor without GMS | Android | FCM not available at all. No push delivery | Native polling (if service alive). checkPending on open | Service likely dead on Huawei. Only recovery: app open |
| HR-04 | Notification cleared + auto_dismissed | Android | Alarm played 2 min -> auto_dismissed -> "Missed" notification posted -> user clears all notifications | checkPending queries `auto_dismissed` on next app open | Recovered on open. Notification may be gone |
| HR-05 | iOS: notification not tapped + never opened app | iOS | APNs notification shown but user ignores. App never opened again | Buzz stays `response='none'` in DB forever. checkPending finds it on any future open | If user never opens app again, buzz lost |
| HR-06 | Android 12+ bg start restriction | Android | ForegroundServiceStartNotAllowedException when starting BuzzerService | Background handler falls through to notifee notification with sound | Notifee fallback works. No full alarm, but notification + channel sound |
| HR-07 | 30+ days inactivity (auto-hibernate) | Android 12+ | Android revokes permissions, restricts app | On next open: re-request notification permission. checkPending finds buzzes | User must grant permission again |

---

## SECTION 5: EMULATOR vs REAL DEVICE REQUIREMENTS

| Test Area | Emulator Sufficient? | Why Real Device Needed |
|---|---|---|
| Foreground delivery (FCM + Realtime) | Yes | - |
| Background delivery (FCM) | Yes (with GMS) | - |
| Killed state (swipe-kill) | Yes | - |
| OEM battery optimization | **No** | MIUI, EMUI, One UI, ColorOS have custom battery managers not in AOSP emulator |
| Doze mode behavior | Partially | Emulator Doze is approximated, not identical to real hardware |
| Long inactivity (3-5 days) | **No** | Standby buckets, token rotation, OEM restrictions only manifest on real devices over real time |
| Vibration | **No** | Emulator has no haptic feedback |
| Alarm volume / speakers | Partially | Emulator audio works but doesn't test max volume, speaker hardware |
| DND bypass | Yes | - |
| Boot receiver | Yes | - |
| iOS APNs delivery | **No** | iOS Simulator cannot receive push notifications. Must use real iPhone |
| iOS background execution limits | **No** | Simulator doesn't enforce background execution limits |
| iOS Focus/DND | Partially | Simulator supports Focus but behavior may differ |

**Minimum real-device test set:**
- 1x Samsung Galaxy (One UI) - most common Android OEM
- 1x Xiaomi/Redmi (MIUI) - most aggressive battery optimization
- 1x iPhone (any recent model) - APNs delivery + background limits
- Optional: 1x Huawei (EMUI/HarmonyOS) if targeting that market

---

## SECTION 6: TEST EXECUTION CHECKLIST

### Pre-Test Setup
- [ ] Two test accounts: "Test Priya" (sender) and "Test Heena" (receiver)
- [ ] Sender on iOS simulator or real device
- [ ] Receiver on Android emulator or real device
- [ ] Verify both accounts logged in and tokens saved (`user_tokens` table has entries)
- [ ] Verify Supabase Edge Function `send-notification` deployed and working
- [ ] Verify Firebase project has both iOS and Android apps configured
- [ ] Clear old test buzzes: `DELETE FROM buzzes WHERE from_user_id = '<test_priya_id>'`

### How to Send a Test Buzz
1. Open app on sender device
2. Tap "People" tab (NOT Favourites)
3. Select receiver user
4. Choose a reason, optionally add note
5. Tap Send

### How to Verify Delivery
1. **Supabase check**: `SELECT id, response, created_at FROM buzzes WHERE to_user_id = '<receiver_id>' ORDER BY created_at DESC LIMIT 5`
2. **Android logcat**: `adb logcat -s BuzzerService ReactNativeJS | grep -i buzz`
3. **iOS console**: Xcode console or `xcrun simctl spawn <device> log show --predicate 'eventMessage CONTAINS "buzz"' --last 2m`
4. **Push delivery**: Check edge function logs in Supabase Dashboard -> Edge Functions -> send-notification -> Logs

### Pass/Fail Summary Template

| Test ID | Platform | State | Result | Notes |
|---|---|---|---|---|
| A-FG-01 | Android Emulator | Foreground | PASS/FAIL | |
| A-BG-01 | Android Emulator | Background | PASS/FAIL | |
| A-KILL-01 | Android Emulator | Killed | PASS/FAIL | |
| A-LI-01 | Android Real (Samsung) | 1 day inactive | PASS/FAIL | |
| I-FG-01 | iOS Real (iPhone) | Foreground | PASS/FAIL | |
| I-BG-01 | iOS Real (iPhone) | Background | PASS/FAIL | |
| I-KILL-01 | iOS Real (iPhone) | Killed | PASS/FAIL | |
| I-LI-01 | iOS Real (iPhone) | 1 day inactive | PASS/FAIL | |
