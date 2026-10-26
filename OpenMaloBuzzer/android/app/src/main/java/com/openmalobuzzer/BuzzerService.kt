package com.openmalobuzzer

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

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
        const val ACTION_SHOW_BUZZ = "com.openmalobuzzer.SHOW_BUZZ"
        const val EXTRA_USER_ID = "user_id"
        const val EXTRA_BUZZ_ID = "buzz_id"
        const val EXTRA_RESPONSE = "response"
        const val EXTRA_FROM_USER_ID = "from_user_id"
        const val EXTRA_FROM_USER_NAME = "from_user_name"
        const val EXTRA_REASON = "reason"
        const val EXTRA_NOTE = "note"
        const val BUZZ_CHANNEL_ID = "openmalo_buzz"
        const val VOICEMAIL_CHANNEL_ID = "openmalo_voicemail"
        const val PREFS_NAME = "buzzer_prefs"
        const val PREF_USER_ID = "active_user_id"
        const val PREF_LAST_HEARTBEAT = "last_heartbeat"
        const val POLL_INTERVAL_MS = 10000L
        const val FCM_TOKEN_REFRESH_MS = 3600000L
        val RESTART_RETRY_DELAYS = longArrayOf(3000L, 10000L, 30000L, 60000L)

        /** Check if service has been alive recently (heartbeat within last 30s). */
        fun isServiceHealthy(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val lastHeartbeat = prefs.getLong(PREF_LAST_HEARTBEAT, 0)
            return System.currentTimeMillis() - lastHeartbeat < 30000
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var isAlarming = false
    private var originalAlarmVolume: Int = -1
    private var originalRingerMode: Int = -1
    private var originalDndMode: Int = -1
    private var activeBuzzId: String? = null
    private val seenBuzzIds = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    private val handler = Handler(Looper.getMainLooper())
    private var currentUserId: String? = null
    private var restartAttempt = 0
    private val userNameCache = mutableMapOf<String, String>()

    private val pollRunnable = object : Runnable {
        override fun run() {
            currentUserId?.let { pollForBuzzes(it) }
            // Write heartbeat so the app can detect if the service was killed by OEM
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putLong(PREF_LAST_HEARTBEAT, System.currentTimeMillis()).apply()
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private val fcmTokenRefreshRunnable = object : Runnable {
        override fun run() {
            currentUserId?.let { refreshFcmToken(it) }
            handler.postDelayed(this, FCM_TOKEN_REFRESH_MS)
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
            stopAlarm()
            cancelActiveBuzzNotification()
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
                respondToBuzzSupabase(buzzId, response)
                cancelAllNotificationsForBuzz(buzzId)
                if (activeBuzzId == buzzId) activeBuzzId = null
            }
            return START_STICKY
        }

        if (action == ACTION_SHOW_BUZZ) {
            // Ensure service is in foreground (needed if service was just started from dead state)
            acquireWakeLock()
            val fgNotification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, fgNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, fgNotification)
            }

            // Start polling if not already running
            val savedUserId = getSavedUserId()
            if (savedUserId != null && currentUserId != savedUserId) {
                Log.d(TAG, "Starting polling from SHOW_BUZZ for userId: $savedUserId")
                currentUserId = savedUserId
                preloadUserNames()
                startPolling()
                cancelRestartAlarm()
            }

            val buzzId = intent?.getStringExtra(EXTRA_BUZZ_ID)
            val fromUserId = intent?.getStringExtra(EXTRA_FROM_USER_ID) ?: ""
            val fromUserName = intent?.getStringExtra(EXTRA_FROM_USER_NAME)
            val reason = intent?.getStringExtra(EXTRA_REASON) ?: ""
            val note = intent?.getStringExtra(EXTRA_NOTE)?.let { if (it.isEmpty() || it == "null") null else it }
            if (buzzId != null && !seenBuzzIds.contains(buzzId)) {
                Log.d(TAG, "Buzz delivered via FCM push: $buzzId")
                seenBuzzIds.add(buzzId)
                // Cache sender name from FCM data so notification shows instantly
                if (!fromUserName.isNullOrEmpty() && fromUserName != "User") {
                    userNameCache[fromUserId] = fromUserName
                }
                stopAlarm()
                activeBuzzId = buzzId
                showBuzzNotification(buzzId, fromUserId, reason, note)
                startAlarm()
                handler.postDelayed({
                    if (activeBuzzId == buzzId) {
                        Log.d(TAG, "Auto-dismissing buzz $buzzId after 2 min timeout")
                        stopAlarm()
                        cancelAllNotificationsForBuzz(buzzId)
                        activeBuzzId = null
                        respondToBuzzSupabase(buzzId, "dismissed")
                    }
                }, 120000)
            }
            return START_STICKY
        }

        val userId = intent?.getStringExtra(EXTRA_USER_ID) ?: getSavedUserId()
        if (userId == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        if (action == ACTION_START) {
            saveUserId(userId)
            restartAttempt = 0
        }

        // Re-acquire WakeLock on every start to ensure polling stays alive
        acquireWakeLock()

        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        if (currentUserId != userId) {
            Log.d(TAG, "Starting polling for userId: $userId")
            currentUserId = userId
            seenBuzzIds.clear()
            preloadUserNames()
            startPolling()
            refreshFcmToken(userId)
            cancelRestartAlarm()
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.d(TAG, "Task removed — scheduling restart")
        scheduleRestartAlarm()
        super.onTaskRemoved(rootIntent)
    }

    // ─── Supabase REST API helpers ─────────────────────────
    private fun supabaseGet(path: String): String? {
        var conn: HttpURLConnection? = null
        try {
            val url = URL("${SupabaseConfig.URL}/rest/v1/$path")
            conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("apikey", SupabaseConfig.ANON_KEY)
            conn.setRequestProperty("Authorization", "Bearer ${SupabaseConfig.ANON_KEY}")
            conn.connectTimeout = 15000
            conn.readTimeout = 15000

            if (conn.responseCode == 200) {
                val reader = BufferedReader(InputStreamReader(conn.inputStream))
                val response = reader.readText()
                reader.close()
                return response
            }
        } catch (e: Exception) {
            Log.e(TAG, "Supabase GET error: ${e.message}")
        } finally {
            conn?.disconnect()
        }
        return null
    }

    private fun supabasePatch(path: String, body: JSONObject) {
        Thread {
            var conn: HttpURLConnection? = null
            try {
                val url = URL("${SupabaseConfig.URL}/rest/v1/$path")
                conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "PATCH"
                conn.setRequestProperty("apikey", SupabaseConfig.ANON_KEY)
                conn.setRequestProperty("Authorization", "Bearer ${SupabaseConfig.ANON_KEY}")
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Prefer", "return=minimal")
                conn.doOutput = true
                val writer = OutputStreamWriter(conn.outputStream)
                writer.write(body.toString())
                writer.flush()
                writer.close()
                conn.responseCode // trigger the request
            } catch (e: Exception) {
                Log.e(TAG, "Supabase PATCH error: ${e.message}")
            } finally {
                conn?.disconnect()
            }
        }.start()
    }

    private fun supabaseUpsert(table: String, body: JSONObject) {
        Thread {
            var conn: HttpURLConnection? = null
            try {
                val url = URL("${SupabaseConfig.URL}/rest/v1/$table")
                conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("apikey", SupabaseConfig.ANON_KEY)
                conn.setRequestProperty("Authorization", "Bearer ${SupabaseConfig.ANON_KEY}")
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Prefer", "resolution=merge-duplicates,return=minimal")
                conn.doOutput = true
                val writer = OutputStreamWriter(conn.outputStream)
                writer.write(body.toString())
                writer.flush()
                writer.close()
                conn.responseCode
            } catch (e: Exception) {
                Log.e(TAG, "Supabase upsert error: ${e.message}")
            } finally {
                conn?.disconnect()
            }
        }.start()
    }

    // ─── Buzz operations ───────────────────────────────────
    private fun respondToBuzzSupabase(buzzId: String, response: String) {
        val body = JSONObject().apply {
            put("response", response)
            put("responded_at", System.currentTimeMillis())
        }
        supabasePatch("buzzes?id=eq.$buzzId", body)
    }

    private fun pollForBuzzes(userId: String) {
        Thread {
            try {
                val json = supabaseGet("buzzes?to_user_id=eq.$userId&response=eq.none&select=*") ?: return@Thread
                val arr = JSONArray(json)
                for (i in 0 until arr.length()) {
                    val buzz = arr.getJSONObject(i)
                    val buzzId = buzz.getString("id")
                    val createdAt = buzz.getLong("created_at")
                    if (System.currentTimeMillis() - createdAt < 120000 && !seenBuzzIds.contains(buzzId)) {
                        Log.d(TAG, "New buzz detected via poll: $buzzId")
                        seenBuzzIds.add(buzzId)
                        handler.post {
                            stopAlarm()
                            activeBuzzId = buzzId
                            showBuzzNotification(
                                buzzId = buzzId,
                                fromUserId = buzz.optString("from_user_id", ""),
                                reason = buzz.optString("reason", ""),
                                note = buzz.optString("note", null).let { if (it == "null") null else it }
                            )
                            startAlarm()
                            // Auto-stop alarm after 2 minutes and mark as dismissed
                            handler.postDelayed({
                                if (activeBuzzId == buzzId) {
                                    Log.d(TAG, "Auto-dismissing buzz $buzzId after 2 min timeout")
                                    stopAlarm()
                                    cancelAllNotificationsForBuzz(buzzId)
                                    activeBuzzId = null
                                    respondToBuzzSupabase(buzzId, "dismissed")
                                }
                            }, 120000)
                        }
                    }
                }
                // Check for responses to active buzzes (cancellation) — only check last 5 minutes
                val since = System.currentTimeMillis() - 300000
                val activeJson = supabaseGet("buzzes?to_user_id=eq.$userId&response=neq.none&created_at=gte.$since&select=id,response,from_user_id") ?: return@Thread
                val activeArr = JSONArray(activeJson)
                for (i in 0 until activeArr.length()) {
                    val buzz = activeArr.getJSONObject(i)
                    val buzzId = buzz.getString("id")
                    val response = buzz.getString("response")
                    if (seenBuzzIds.contains(buzzId)) {
                        val fromUserId = buzz.optString("from_user_id", "")
                        seenBuzzIds.remove(buzzId) // Remove so we don't process again
                        handler.post {
                            stopAlarm()
                            cancelAllNotificationsForBuzz(buzzId)
                            if (activeBuzzId == buzzId) activeBuzzId = null
                            if (response == "cancelled") {
                                showCancelledNotification(buzzId, fromUserId)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Poll failed: ${e.message}")
            }
            if (seenBuzzIds.size > 50) seenBuzzIds.clear()
        }.start()
    }

    private fun preloadUserNames() {
        Thread {
            try {
                val json = supabaseGet("users?is_active=eq.true&select=id,name") ?: return@Thread
                val arr = JSONArray(json)
                for (i in 0 until arr.length()) {
                    val user = arr.getJSONObject(i)
                    userNameCache[user.getString("id")] = user.getString("name")
                }
                Log.d(TAG, "Preloaded ${userNameCache.size} user names")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to preload user names: ${e.message}")
            }
        }.start()
    }

    private fun refreshFcmToken(userId: String) {
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    if (token.isNullOrEmpty()) return@addOnSuccessListener
                    Log.d(TAG, "FCM token refreshed, saving to Supabase")
                    val body = JSONObject().apply {
                        put("user_id", userId)
                        put("fcm_token", token)
                        put("fcm_token_stale", false)
                    }
                    supabaseUpsert("user_tokens", body)
                }
                .addOnFailureListener { e ->
                    Log.e(TAG, "Failed to get FCM token: ${e.message}")
                }
        } catch (e: Exception) {
            Log.e(TAG, "refreshFcmToken error: ${e.message}")
        }
    }

    // ─── Polling management ────────────────────────────────
    private fun startPolling() {
        handler.removeCallbacks(pollRunnable)
        handler.post(pollRunnable)
        handler.removeCallbacks(fcmTokenRefreshRunnable)
        handler.postDelayed(fcmTokenRefreshRunnable, FCM_TOKEN_REFRESH_MS)
    }

    private fun stopPolling() {
        handler.removeCallbacks(pollRunnable)
        handler.removeCallbacks(fcmTokenRefreshRunnable)
        currentUserId = null
    }

    // ─── Restart management ────────────────────────────────
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
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + delay, pendingIntent)
            } else {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + delay, pendingIntent)
            }
            Log.d(TAG, "Restart scheduled in ${delay}ms (attempt $restartAttempt)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule restart: ${e.message}")
        }
    }

    private fun cancelRestartAlarm() {
        val restartIntent = Intent(this, BuzzerService::class.java).apply { action = ACTION_START }
        val pendingIntent = PendingIntent.getService(
            this, RESTART_REQUEST_CODE, restartIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE
        )
        if (pendingIntent != null) {
            (getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pendingIntent)
        }
    }

    private fun saveUserId(userId: String) {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(PREF_USER_ID, userId).apply()
    }

    private fun getSavedUserId(): String? =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(PREF_USER_ID, null)

    private fun clearSavedUserId() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().remove(PREF_USER_ID).apply()
    }

    // ─── Alarm ─────────────────────────────────────────────
    private fun startAlarm() {
        if (isAlarming) return
        isAlarming = true

        try {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.isNotificationPolicyAccessGranted) {
                originalDndMode = nm.currentInterruptionFilter
                if (originalDndMode != NotificationManager.INTERRUPTION_FILTER_ALL) {
                    nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
                }
            }
        } catch (_: Exception) {}

        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            originalAlarmVolume = audioManager.getStreamVolume(AudioManager.STREAM_ALARM)
            audioManager.setStreamVolume(AudioManager.STREAM_ALARM, audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            originalRingerMode = audioManager.ringerMode
            if (audioManager.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
                audioManager.ringerMode = AudioManager.RINGER_MODE_NORMAL
            }
        } catch (_: Exception) {}

        val pattern = longArrayOf(0, 500, 200, 500, 200, 500, 200, 500)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION") vibrator?.vibrate(pattern, 0)
        }

        try {
            val soundUri = Uri.parse("android.resource://$packageName/raw/buzz_alarm")
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build())
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

        if (originalAlarmVolume >= 0) {
            try {
                val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, originalAlarmVolume, 0)
                if (originalRingerMode >= 0) audioManager.ringerMode = originalRingerMode
            } catch (_: Exception) {}
            originalAlarmVolume = -1
            originalRingerMode = -1
        }

        if (originalDndMode >= 0) {
            try {
                val nm = getSystemService(NotificationManager::class.java)
                if (nm.isNotificationPolicyAccessGranted && originalDndMode != NotificationManager.INTERRUPTION_FILTER_ALL) {
                    nm.setInterruptionFilter(originalDndMode)
                }
            } catch (_: Exception) {}
            originalDndMode = -1
        }
    }

    // ─── Notifications ─────────────────────────────────────
    private fun cancelActiveBuzzNotification() {
        activeBuzzId?.let {
            getSystemService(NotificationManager::class.java).cancel(it.hashCode())
            activeBuzzId = null
        }
    }

    private fun cancelAllNotificationsForBuzz(buzzId: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.cancel(buzzId.hashCode())
        nm.cancel(buzzId, 0)
        for (n in nm.activeNotifications) {
            if (n.tag == buzzId) nm.cancel(n.tag, n.id)
        }
    }

    private fun resolveUserName(userId: String, callback: (String) -> Unit) {
        if (userId.isEmpty()) { callback("Unknown"); return }
        val cached = userNameCache[userId]
        if (cached != null) { callback(cached); return }
        Thread {
            try {
                val json = supabaseGet("users?id=eq.$userId&select=name") ?: run { handler.post { callback("User") }; return@Thread }
                val arr = JSONArray(json)
                val name = if (arr.length() > 0) arr.getJSONObject(0).optString("name", "User") else "User"
                userNameCache[userId] = name
                handler.post { callback(name) }
            } catch (_: Exception) {
                handler.post { callback("User") }
            }
        }.start()
    }

    private fun coloredText(text: String, color: Int): SpannableString {
        val s = SpannableString(text)
        s.setSpan(ForegroundColorSpan(color), 0, text.length, 0)
        return s
    }

    private fun showBuzzNotification(buzzId: String, fromUserId: String, reason: String, note: String?) {
        resolveUserName(fromUserId) { senderName ->
            cancelAllNotificationsForBuzz(buzzId)
            val body = if (note.isNullOrEmpty() || note == "null") reason else "$reason — $note"
            val launchIntent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("buzz_id", buzzId)
                putExtra("from_user_id", fromUserId)
                putExtra("from_user_name", senderName)
                putExtra("reason", reason)
                putExtra("note", note ?: "")
            }
            val pendingIntent = PendingIntent.getActivity(this, buzzId.hashCode(), launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

            fun respondIntent(response: String, rc: Int): PendingIntent {
                val i = Intent(this, BuzzerService::class.java).apply {
                    action = ACTION_RESPOND
                    putExtra(EXTRA_BUZZ_ID, buzzId)
                    putExtra(EXTRA_RESPONSE, response)
                }
                return PendingIntent.getService(this, rc, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }

            createBuzzChannel()

            val notification = NotificationCompat.Builder(this, BUZZ_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Buzz from $senderName")
                .setContentText(body)
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

            getSystemService(NotificationManager::class.java).notify(buzzId.hashCode(), notification)

            // Delayed cleanup: cancel any FCM/notifee duplicate notification
            handler.postDelayed({
                val nm2 = getSystemService(NotificationManager::class.java)
                nm2.cancel(buzzId, 0)
                for (n in nm2.activeNotifications) {
                    if (n.tag == buzzId) nm2.cancel(n.tag, n.id)
                }
            }, 3000)
        }
    }

    private fun showCancelledNotification(buzzId: String, fromUserId: String) {
        resolveUserName(fromUserId) { senderName ->
            val notification = NotificationCompat.Builder(this, BUZZ_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Buzz cancelled")
                .setContentText("$senderName cancelled the buzz")
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setTimeoutAfter(10000)
                .build()
            getSystemService(NotificationManager::class.java).notify((buzzId + "_cancel").hashCode(), notification)
        }
    }

    // ─── Channels ──────────────────────────────────────────
    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Buzzer")
            .setContentText("Listening for incoming buzzes")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .build()

    private fun createServiceChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Buzzer Service", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps Buzzer listening for incoming buzzes"
            })
        }
    }

    private fun createVoiceMailChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(VOICEMAIL_CHANNEL_ID, "Voice Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Voice message notifications"
            })
        }
    }

    private fun createBuzzChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(BUZZ_CHANNEL_ID, "Buzzer Alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Incoming buzz alerts"
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        // Release any existing WakeLock before acquiring a new one
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "buzzer::listener").apply {
            acquire() // No timeout — released in onDestroy()
        }
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        super.onTimeout(startId, fgsType)
        Log.d(TAG, "FGS timeout (dataSync limit) — restarting")
        scheduleRestartAlarm()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed — scheduling restart")
        stopAlarm()
        cancelActiveBuzzNotification()
        stopPolling()
        if (getSavedUserId() != null) scheduleRestartAlarm()
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
