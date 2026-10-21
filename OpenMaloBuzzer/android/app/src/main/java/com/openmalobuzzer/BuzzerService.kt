package com.openmalobuzzer

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.text.SpannableString
import android.text.style.ForegroundColorSpan
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.messaging.FirebaseMessaging

class BuzzerService : Service() {

    companion object {
        const val TAG = "BuzzerService"
        const val CHANNEL_ID = "buzzer_service_channel"
        const val NOTIFICATION_ID = 1001
        const val RESTART_REQUEST_CODE = 9999
        const val ACTION_START = "com.openmalobuzzer.START_SERVICE"
        const val ACTION_STOP = "com.openmalobuzzer.STOP_SERVICE"
        const val ACTION_STOP_ALARM = "com.openmalobuzzer.STOP_ALARM"
        const val ACTION_RESPOND = "com.openmalobuzzer.RESPOND"
        const val EXTRA_USER_ID = "user_id"
        const val EXTRA_BUZZ_ID = "buzz_id"
        const val EXTRA_RESPONSE = "response"
        const val BUZZ_CHANNEL_ID = "openmalo_buzz"
        const val VOICEMAIL_CHANNEL_ID = "openmalo_voicemail"
        const val PREFS_NAME = "buzzer_prefs"
        const val PREF_USER_ID = "active_user_id"
        const val POLL_INTERVAL_MS = 15000L
        const val LISTENER_REFRESH_MS = 300000L // 5 minutes — re-establish Firestore listeners
        const val FCM_TOKEN_REFRESH_MS = 3600000L // 1 hour — refresh FCM token
        const val AUTH_CHECK_MS = 1800000L // 30 minutes — check Firebase Auth
        val RESTART_RETRY_DELAYS = longArrayOf(3000L, 10000L, 30000L, 60000L) // escalating restart delays
    }

    private var buzzListener: ListenerRegistration? = null
    private var responseListener: ListenerRegistration? = null
    private var voiceMailListener: ListenerRegistration? = null
    private val seenVoiceMailIds = mutableSetOf<String>()
    private var wakeLock: PowerManager.WakeLock? = null
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var isAlarming = false
    private var originalAlarmVolume: Int = -1
    private var originalRingerMode: Int = -1
    private var originalDndMode: Int = -1
    private var activeBuzzId: String? = null
    private val seenBuzzIds = mutableSetOf<String>()
    private val handler = Handler(Looper.getMainLooper())
    private var currentUserId: String? = null
    private var restartAttempt = 0
    private var listenerRetryCount = 0
    private val userNameCache = mutableMapOf<String, String>()

    private val pollRunnable = object : Runnable {
        override fun run() {
            currentUserId?.let { userId ->
                pollForBuzzes(userId)
            }
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private val listenerRefreshRunnable = object : Runnable {
        override fun run() {
            currentUserId?.let { userId ->
                Log.d(TAG, "Periodic listener refresh for userId: $userId")
                listenerRetryCount = 0 // Reset backoff on periodic refresh
                startListening(userId)
            }
            handler.postDelayed(this, LISTENER_REFRESH_MS)
        }
    }

    // Fix #1: Periodically refresh FCM token in native service
    private val fcmTokenRefreshRunnable = object : Runnable {
        override fun run() {
            currentUserId?.let { userId ->
                refreshFcmToken(userId)
            }
            handler.postDelayed(this, FCM_TOKEN_REFRESH_MS)
        }
    }

    // Fix #3: Periodically check Firebase Auth is valid
    private val authCheckRunnable = object : Runnable {
        override fun run() {
            ensureFirebaseAuth {
                // After auth check, refresh listeners if needed
                currentUserId?.let { userId ->
                    if (buzzListener == null) {
                        Log.d(TAG, "Auth check: listeners were null, restarting")
                        startListening(userId)
                    }
                }
            }
            handler.postDelayed(this, AUTH_CHECK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createServiceChannel()
        createVoiceMailChannel()
        acquireWakeLock()
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action

        if (action == ACTION_STOP) {
            Log.d(TAG, "Stopping service")
            stopAlarm()
            cancelActiveBuzzNotification()
            stopListening()
            stopPolling()
            clearSavedUserId()
            cancelRestartAlarm()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        if (action == ACTION_STOP_ALARM) {
            stopAlarm()
            cancelActiveBuzzNotification()
            activeBuzzId = null
            return START_STICKY
        }

        if (action == ACTION_RESPOND) {
            val buzzId = intent?.getStringExtra(EXTRA_BUZZ_ID)
            val response = intent?.getStringExtra(EXTRA_RESPONSE)
            if (buzzId != null && response != null) {
                Log.d(TAG, "Responding to $buzzId with $response")
                stopAlarm()
                val db = FirebaseFirestore.getInstance()
                db.collection("buzzes").document(buzzId)
                    .update(mapOf("response" to response, "responded_at" to System.currentTimeMillis()))
                cancelAllNotificationsForBuzz(buzzId)
                if (activeBuzzId == buzzId) activeBuzzId = null
            }
            return START_STICKY
        }

        // Get userId from intent or SharedPreferences
        val userId = intent?.getStringExtra(EXTRA_USER_ID) ?: getSavedUserId()
        if (userId == null) {
            Log.d(TAG, "No userId available, stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        if (action == ACTION_START) {
            saveUserId(userId)
            restartAttempt = 0 // Reset restart counter on explicit start
        }

        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)

        // Fix #3: Ensure Firebase Auth before starting listeners
        ensureFirebaseAuth {
            // Only re-attach listeners if not already listening for this user
            if (currentUserId != userId || buzzListener == null) {
                Log.d(TAG, "Starting listeners for userId: $userId")
                startListening(userId)
                startPolling()
            }
            // Fix #1: Refresh FCM token on service start
            refreshFcmToken(userId)
            // Cancel restart alarm on successful setup
            cancelRestartAlarm()
            restartAttempt = 0
        }

        return START_STICKY
    }

    // Called when user swipes app from recents — schedule restart
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.d(TAG, "Task removed — scheduling restart")
        scheduleRestartAlarm()
        super.onTaskRemoved(rootIntent)
    }

    // Fix #4: Escalating restart delays with multiple attempts
    private fun scheduleRestartAlarm() {
        try {
            val userId = getSavedUserId() ?: return
            val delayIndex = restartAttempt.coerceAtMost(RESTART_RETRY_DELAYS.size - 1)
            val delay = RESTART_RETRY_DELAYS[delayIndex]
            restartAttempt++

            val restartIntent = Intent(this, BuzzerService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_USER_ID, userId)
            }
            val pendingIntent = PendingIntent.getService(
                this, RESTART_REQUEST_CODE, restartIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + delay,
                    pendingIntent
                )
                Log.d(TAG, "Restart alarm scheduled (inexact) in ${delay}ms (attempt $restartAttempt)")
            } else {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + delay,
                    pendingIntent
                )
                Log.d(TAG, "Restart alarm scheduled (exact) in ${delay}ms (attempt $restartAttempt)")
            }

            // Fix #4: Schedule a secondary backup alarm at a longer delay
            if (restartAttempt <= 2) {
                val backupIntent = Intent(this, BuzzerService::class.java).apply {
                    action = ACTION_START
                    putExtra(EXTRA_USER_ID, userId)
                }
                val backupPending = PendingIntent.getService(
                    this, RESTART_REQUEST_CODE + 1, backupIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + 120000, // 2 minute backup
                    backupPending
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule restart: ${e.message}")
        }
    }

    private fun cancelRestartAlarm() {
        val restartIntent = Intent(this, BuzzerService::class.java).apply {
            action = ACTION_START
        }
        val pendingIntent = PendingIntent.getService(
            this, RESTART_REQUEST_CODE, restartIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE
        )
        if (pendingIntent != null) {
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarmManager.cancel(pendingIntent)
        }
        // Also cancel backup alarm
        val backupIntent = Intent(this, BuzzerService::class.java).apply {
            action = ACTION_START
        }
        val backupPending = PendingIntent.getService(
            this, RESTART_REQUEST_CODE + 1, backupIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE
        )
        if (backupPending != null) {
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarmManager.cancel(backupPending)
        }
    }

    private fun saveUserId(userId: String) {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(PREF_USER_ID, userId).apply()
    }

    private fun getSavedUserId(): String? {
        return getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(PREF_USER_ID, null)
    }

    private fun clearSavedUserId() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().remove(PREF_USER_ID).apply()
    }

    // Fix #3: Ensure Firebase Anonymous Auth is valid
    private fun ensureFirebaseAuth(onComplete: () -> Unit) {
        try {
            val auth = FirebaseAuth.getInstance()
            val user = auth.currentUser
            if (user == null) {
                Log.d(TAG, "No Firebase Auth user, signing in anonymously")
                auth.signInAnonymously()
                    .addOnSuccessListener {
                        Log.d(TAG, "Anonymous auth successful")
                        onComplete()
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "Anonymous auth failed: ${e.message}")
                        onComplete() // Continue anyway, polling may still work
                    }
            } else {
                // Force token refresh to ensure the auth token is still valid
                user.getIdToken(true)
                    .addOnSuccessListener {
                        Log.d(TAG, "Auth token refreshed successfully")
                        onComplete()
                    }
                    .addOnFailureListener { e ->
                        Log.w(TAG, "Auth token refresh failed, re-authenticating: ${e.message}")
                        auth.signInAnonymously()
                            .addOnSuccessListener {
                                Log.d(TAG, "Re-authentication successful")
                                onComplete()
                            }
                            .addOnFailureListener { e2 ->
                                Log.e(TAG, "Re-authentication failed: ${e2.message}")
                                onComplete()
                            }
                    }
            }
        } catch (e: Exception) {
            Log.e(TAG, "ensureFirebaseAuth error: ${e.message}")
            onComplete()
        }
    }

    // Fix #1: Refresh FCM token and save to Firestore from native service
    private fun refreshFcmToken(userId: String) {
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    if (token.isNullOrEmpty()) return@addOnSuccessListener
                    Log.d(TAG, "FCM token refreshed, saving to Firestore")
                    val db = FirebaseFirestore.getInstance()
                    db.collection("user_tokens").document(userId)
                        .set(mapOf("fcm_token" to token, "fcm_token_stale" to false))
                        .addOnSuccessListener {
                            Log.d(TAG, "FCM token saved successfully")
                        }
                        .addOnFailureListener { e ->
                            Log.e(TAG, "Failed to save FCM token: ${e.message}")
                        }
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "Failed to get FCM token: ${e.message}")
                }
        } catch (e: Exception) {
            Log.e(TAG, "refreshFcmToken error: ${e.message}")
        }
    }

    private fun getListenerRetryDelay(): Long {
        val delay = (5000L * (1 shl listenerRetryCount.coerceAtMost(4))).coerceAtMost(120000L) // 5s, 10s, 20s, 40s, 80s, max 120s
        listenerRetryCount++
        return delay
    }

    private fun scheduleListenerReconnect(userId: String) {
        val delay = getListenerRetryDelay()
        Log.d(TAG, "Scheduling listener reconnect in ${delay}ms (attempt $listenerRetryCount)")
        handler.postDelayed({
            ensureFirebaseAuth { startListening(userId) }
        }, delay)
    }

    private fun preloadUserNames() {
        val db = FirebaseFirestore.getInstance()
        db.collection("users").whereEqualTo("is_active", true).get()
            .addOnSuccessListener { snap ->
                for (doc in snap.documents) {
                    val name = doc.getString("name")
                    if (name != null) userNameCache[doc.id] = name
                }
                Log.d(TAG, "Preloaded ${userNameCache.size} user names")
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to preload user names: ${e.message}")
            }
    }

    private fun startListening(userId: String) {
        stopListening()
        currentUserId = userId
        seenBuzzIds.clear()
        preloadUserNames()
        val db = FirebaseFirestore.getInstance()
        Log.d(TAG, "Starting Firestore listener for userId: $userId")

        buzzListener = db.collection("buzzes")
            .whereEqualTo("to_user_id", userId)
            .whereEqualTo("response", "none")
            .addSnapshotListener { snapshots, error ->
                if (error != null) {
                    Log.e(TAG, "Buzz listener error: ${error.message}")
                    scheduleListenerReconnect(userId)
                    return@addSnapshotListener
                }
                listenerRetryCount = 0 // Reset on successful snapshot
                if (snapshots == null) return@addSnapshotListener
                Log.d(TAG, "Buzz snapshot: ${snapshots.documents.size} docs, ${snapshots.documentChanges.size} changes")
                for (change in snapshots.documentChanges) {
                    if (change.type == com.google.firebase.firestore.DocumentChange.Type.ADDED) {
                        val buzzId = change.document.id
                        val data = change.document.data
                        val createdAt = data["created_at"] as? Long ?: 0L
                        if (System.currentTimeMillis() - createdAt < 120000 && !seenBuzzIds.contains(buzzId)) {
                            Log.d(TAG, "New buzz detected via listener: $buzzId")
                            seenBuzzIds.add(buzzId)
                            stopAlarm()
                            activeBuzzId = buzzId
                            showBuzzNotification(
                                buzzId = buzzId,
                                fromUserId = data["from_user_id"] as? String ?: "",
                                reason = data["reason"] as? String ?: "",
                                note = data["note"] as? String
                            )
                            startAlarm()
                        }
                    }
                }
            }

        // Fix #2: Add error recovery to responseListener
        responseListener = db.collection("buzzes")
            .whereEqualTo("to_user_id", userId)
            .addSnapshotListener { snapshots, error ->
                if (error != null) {
                    Log.e(TAG, "Response listener error: ${error.message}")
                    scheduleListenerReconnect(userId)
                    return@addSnapshotListener
                }
                if (snapshots == null) return@addSnapshotListener
                for (change in snapshots.documentChanges) {
                    if (change.type == com.google.firebase.firestore.DocumentChange.Type.MODIFIED) {
                        val buzzId = change.document.id
                        val data = change.document.data
                        val response = data["response"] as? String ?: "none"
                        if (response != "none") {
                            Log.d(TAG, "Response detected for $buzzId: $response")
                            stopAlarm()
                            cancelAllNotificationsForBuzz(buzzId)
                            if (activeBuzzId == buzzId) {
                                activeBuzzId = null
                            }
                            if (response == "cancelled" && seenBuzzIds.contains(buzzId)) {
                                val fromUserId = data["from_user_id"] as? String ?: ""
                                showCancelledNotification(buzzId, fromUserId)
                            }
                        }
                    }
                }
            }

        // Fix #2: Add error recovery to voiceMailListener
        Log.d(TAG, "Setting up voice mail listener for userId: $userId")
        voiceMailListener = db.collection("voice_mails")
            .whereEqualTo("to_user_id", userId)
            .addSnapshotListener { snapshots, error ->
                if (error != null) {
                    Log.e(TAG, "Voice mail listener error: ${error.message}")
                    scheduleListenerReconnect(userId)
                    return@addSnapshotListener
                }
                if (snapshots == null) return@addSnapshotListener
                Log.d(TAG, "Voice mail snapshot: ${snapshots.documents.size} docs, ${snapshots.documentChanges.size} changes")
                for (change in snapshots.documentChanges) {
                    if (change.type == com.google.firebase.firestore.DocumentChange.Type.ADDED) {
                        val mailId = change.document.id
                        val data = change.document.data
                        val createdAt = data["created_at"] as? Long ?: 0L
                        val listened = data["listened"] as? Boolean ?: false
                        val deleted = data["deleted"] as? Boolean ?: false
                        val age = System.currentTimeMillis() - createdAt
                        Log.d(TAG, "Voice mail ADDED: $mailId, age=${age}ms, listened=$listened, deleted=$deleted, seen=${seenVoiceMailIds.contains(mailId)}")
                        if (!listened && !deleted && age < 120000 && !seenVoiceMailIds.contains(mailId)) {
                            seenVoiceMailIds.add(mailId)
                            val fromUserId = data["from_user_id"] as? String ?: ""
                            val duration = data["duration_seconds"] as? Long ?: 0L
                            showVoiceMailNotification(mailId, fromUserId, duration)
                        }
                    }
                }
                if (seenVoiceMailIds.size > 50) seenVoiceMailIds.clear()
            }
    }

    private fun pollForBuzzes(userId: String) {
        val db = FirebaseFirestore.getInstance()
        db.collection("buzzes")
            .whereEqualTo("to_user_id", userId)
            .whereEqualTo("response", "none")
            .get()
            .addOnSuccessListener { snapshots ->
                for (doc in snapshots.documents) {
                    val buzzId = doc.id
                    val data = doc.data ?: continue
                    val createdAt = data["created_at"] as? Long ?: 0L
                    if (System.currentTimeMillis() - createdAt < 120000 && !seenBuzzIds.contains(buzzId)) {
                        Log.d(TAG, "New buzz detected via POLL: $buzzId")
                        seenBuzzIds.add(buzzId)
                        stopAlarm()
                        activeBuzzId = buzzId
                        showBuzzNotification(
                            buzzId = buzzId,
                            fromUserId = data["from_user_id"] as? String ?: "",
                            reason = data["reason"] as? String ?: "",
                            note = data["note"] as? String
                        )
                        startAlarm()
                    }
                }
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Poll failed: ${e.message}")
                // If poll fails, check auth and retry poll after a short delay
                ensureFirebaseAuth {
                    handler.postDelayed({
                        currentUserId?.let { uid -> pollForBuzzes(uid) }
                    }, 5000)
                }
            }

        if (seenBuzzIds.size > 50) seenBuzzIds.clear()
    }

    private fun startPolling() {
        handler.removeCallbacks(pollRunnable)
        handler.postDelayed(pollRunnable, POLL_INTERVAL_MS)
        handler.removeCallbacks(listenerRefreshRunnable)
        handler.postDelayed(listenerRefreshRunnable, LISTENER_REFRESH_MS)
        // Fix #1: Start periodic FCM token refresh
        handler.removeCallbacks(fcmTokenRefreshRunnable)
        handler.postDelayed(fcmTokenRefreshRunnable, FCM_TOKEN_REFRESH_MS)
        // Fix #3: Start periodic auth check
        handler.removeCallbacks(authCheckRunnable)
        handler.postDelayed(authCheckRunnable, AUTH_CHECK_MS)
    }

    private fun stopPolling() {
        handler.removeCallbacks(pollRunnable)
        handler.removeCallbacks(listenerRefreshRunnable)
        handler.removeCallbacks(fcmTokenRefreshRunnable)
        handler.removeCallbacks(authCheckRunnable)
    }

    private fun showCancelledNotification(buzzId: String, fromUserId: String) {
        resolveUserName(fromUserId) { senderName ->
            Log.d(TAG, "Showing cancelled notification from $senderName")
            val launchIntent = Intent(this, MainActivity::class.java)
            val pendingIntent = PendingIntent.getActivity(
                this, (buzzId + "_cancel").hashCode(), launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notification = NotificationCompat.Builder(this, BUZZ_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Buzz cancelled")
                .setContentText("$senderName cancelled the buzz")
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setTimeoutAfter(10000)
                .setContentIntent(pendingIntent)
                .build()
            val nm = getSystemService(NotificationManager::class.java)
            nm.notify((buzzId + "_cancel").hashCode(), notification)
        }
    }

    private fun coloredText(text: String, color: Int): SpannableString {
        val spannable = SpannableString(text)
        spannable.setSpan(ForegroundColorSpan(color), 0, text.length, 0)
        return spannable
    }

    private fun startAlarm() {
        if (isAlarming) return
        isAlarming = true

        // Disable DND temporarily so alarm is not blocked
        try {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.isNotificationPolicyAccessGranted) {
                originalDndMode = nm.currentInterruptionFilter
                if (originalDndMode != NotificationManager.INTERRUPTION_FILTER_ALL) {
                    nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
                    Log.d(TAG, "DND disabled temporarily for buzz alarm")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to disable DND: ${e.message}")
        }

        // Force alarm volume to max
        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            originalAlarmVolume = audioManager.getStreamVolume(AudioManager.STREAM_ALARM)
            val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            audioManager.setStreamVolume(AudioManager.STREAM_ALARM, maxVolume, 0)

            // Also force ringer mode to normal so vibration + sound both work
            originalRingerMode = audioManager.ringerMode
            if (audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
                audioManager.ringerMode = AudioManager.RINGER_MODE_NORMAL
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to set alarm volume: ${e.message}")
        }

        val pattern = longArrayOf(0, 500, 200, 500, 200, 500, 200, 500)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0)
        }
        try {
            val soundUri = Uri.parse("android.resource://$packageName/raw/buzz_alarm")
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(this@BuzzerService, soundUri)
                isLooping = true
                setVolume(1.0f, 1.0f)
                prepare()
                start()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Alarm sound error: ${e.message}")
        }
    }

    private fun stopAlarm() {
        isAlarming = false
        vibrator?.cancel()
        mediaPlayer?.let {
            try { if (it.isPlaying) it.stop() } catch (_: Exception) {}
            try { it.release() } catch (_: Exception) {}
        }
        mediaPlayer = null

        // Restore original alarm volume and ringer mode
        if (originalAlarmVolume >= 0) {
            try {
                val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, originalAlarmVolume, 0)
                if (originalRingerMode >= 0) {
                    audioManager.ringerMode = originalRingerMode
                }
            } catch (_: Exception) {}
            originalAlarmVolume = -1
            originalRingerMode = -1
        }

        // Restore original DND mode
        if (originalDndMode >= 0) {
            try {
                val nm = getSystemService(NotificationManager::class.java)
                if (nm.isNotificationPolicyAccessGranted && originalDndMode != NotificationManager.INTERRUPTION_FILTER_ALL) {
                    nm.setInterruptionFilter(originalDndMode)
                    Log.d(TAG, "DND restored to original mode")
                }
            } catch (_: Exception) {}
            originalDndMode = -1
        }
    }

    private fun cancelActiveBuzzNotification() {
        activeBuzzId?.let { buzzId ->
            val nm = getSystemService(NotificationManager::class.java)
            nm.cancel(buzzId.hashCode())
            activeBuzzId = null
        }
    }

    // Cancel both native and notifee notifications for a buzz
    private fun cancelAllNotificationsForBuzz(buzzId: String) {
        val nm = getSystemService(NotificationManager::class.java)
        // Cancel native notification (uses hashCode as ID)
        nm.cancel(buzzId.hashCode())
        // Cancel notifee notification (uses buzzId string as tag with ID 0)
        nm.cancel(buzzId, 0)
        // Also try cancelling all active notifications matching this buzz ID
        for (notification in nm.activeNotifications) {
            if (notification.tag == buzzId) {
                nm.cancel(notification.tag, notification.id)
            }
        }
    }

    private fun stopListening() {
        buzzListener?.remove()
        buzzListener = null
        responseListener?.remove()
        responseListener = null
        voiceMailListener?.remove()
        voiceMailListener = null
        currentUserId = null
    }

    private fun resolveUserName(userId: String, callback: (String) -> Unit) {
        if (userId.isEmpty()) {
            callback("Unknown")
            return
        }
        val cached = userNameCache[userId]
        if (cached != null) {
            callback(cached)
            return
        }
        val db = FirebaseFirestore.getInstance()
        db.collection("users").document(userId).get()
            .addOnSuccessListener { doc ->
                val name = doc.getString("name") ?: "User"
                userNameCache[userId] = name
                callback(name)
            }
            .addOnFailureListener {
                callback("User")
            }
    }

    private fun showBuzzNotification(buzzId: String, fromUserId: String, reason: String, note: String?) {
        resolveUserName(fromUserId) { senderName ->
                val body = if (note.isNullOrEmpty()) reason else "$reason — $note"
                Log.d(TAG, "Showing notification: Buzz from $senderName - $body")

                val launchIntent = Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra("buzz_id", buzzId)
                    putExtra("from_user_id", fromUserId)
                    putExtra("from_user_name", senderName)
                    putExtra("reason", reason)
                    putExtra("note", note ?: "")
                }
                val pendingIntent = PendingIntent.getActivity(
                    this, buzzId.hashCode(), launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                fun respondIntent(response: String, requestCode: Int): PendingIntent {
                    val intent = Intent(this, BuzzerService::class.java).apply {
                        action = ACTION_RESPOND
                        putExtra(EXTRA_BUZZ_ID, buzzId)
                        putExtra(EXTRA_RESPONSE, response)
                    }
                    return PendingIntent.getService(
                        this, requestCode, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                }

                createBuzzChannel()

                val notification = NotificationCompat.Builder(this, BUZZ_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("Buzz from $senderName")
                    .setContentText(body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText("$body\n\nTap to open or use actions below"))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setAutoCancel(true)
                    .setOngoing(true)
                    .setFullScreenIntent(pendingIntent, true)
                    .setContentIntent(pendingIntent)
                    .addAction(0, coloredText("✓ Ack", 0xFF4CAF50.toInt()), respondIntent("ack", buzzId.hashCode() + 1))
                    .addAction(0, coloredText("⏱ 5 min", 0xFFFF9800.toInt()), respondIntent("five_min", buzzId.hashCode() + 2))
                    .addAction(0, coloredText("✗ Busy", 0xFFF44336.toInt()), respondIntent("busy", buzzId.hashCode() + 3))
                    .build()

                val nm = getSystemService(NotificationManager::class.java)
                nm.notify(buzzId.hashCode(), notification)
            }
    }

    private fun showVoiceMailNotification(mailId: String, fromUserId: String, duration: Long) {
        resolveUserName(fromUserId) { senderName ->
                Log.d(TAG, "Showing voice mail notification from $senderName")

                val launchIntent = Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra("navigate_to", "voice_mail")
                }
                val pendingIntent = PendingIntent.getActivity(
                    this, mailId.hashCode(), launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                val notification = NotificationCompat.Builder(this, VOICEMAIL_CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("Voice message from $senderName")
                    .setContentText("${duration}s voice message")
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setAutoCancel(true)
                    .setContentIntent(pendingIntent)
                    .build()

                val nm = getSystemService(NotificationManager::class.java)
                nm.notify(mailId.hashCode(), notification)
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Buzzer")
            .setContentText("Listening for incoming buzzes")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun createServiceChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Buzzer Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Keeps Buzzer listening for incoming buzzes" }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun createVoiceMailChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                VOICEMAIL_CHANNEL_ID, "Voice Messages",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Voice message notifications"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun createBuzzChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                BUZZ_CHANNEL_ID, "Buzzer Alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Incoming buzz alerts"
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    // Fix #4: Use wake lock with timeout that auto-renews
    private fun acquireWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "buzzer::listener").apply {
            acquire(24 * 60 * 60 * 1000L) // 24 hour timeout, renewed on service restart
        }
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed — scheduling restart")
        stopAlarm()
        cancelActiveBuzzNotification()
        stopListening()
        stopPolling()
        // Always try to restart unless explicitly stopped
        if (getSavedUserId() != null) {
            scheduleRestartAlarm()
        }
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
