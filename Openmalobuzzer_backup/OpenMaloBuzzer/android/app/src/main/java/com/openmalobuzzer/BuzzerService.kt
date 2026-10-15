package com.openmalobuzzer

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
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
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration

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
        const val PREFS_NAME = "buzzer_prefs"
        const val PREF_USER_ID = "active_user_id"
        const val POLL_INTERVAL_MS = 15000L
    }

    private var buzzListener: ListenerRegistration? = null
    private var responseListener: ListenerRegistration? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var isAlarming = false
    private var activeBuzzId: String? = null
    private val seenBuzzIds = mutableSetOf<String>()
    private val handler = Handler(Looper.getMainLooper())
    private var currentUserId: String? = null

    private val pollRunnable = object : Runnable {
        override fun run() {
            currentUserId?.let { userId ->
                pollForBuzzes(userId)
            }
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createServiceChannel()
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
            // Mark buzz as dismissed in Firestore so sender knows
            activeBuzzId?.let { buzzId ->
                Log.d(TAG, "Buzz dismissed: $buzzId")
                val db = FirebaseFirestore.getInstance()
                db.collection("buzzes").document(buzzId)
                    .update(mapOf("response" to "dismissed", "responded_at" to System.currentTimeMillis()))
            }
            cancelActiveBuzzNotification()
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
                val nm = getSystemService(NotificationManager::class.java)
                nm.cancel(buzzId.hashCode())
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
        }

        Log.d(TAG, "Starting/resuming service for userId: $userId (action: $action)")
        val notification = buildNotification()
        startForeground(NOTIFICATION_ID, notification)
        startListening(userId)
        startPolling()
        scheduleRestartAlarm()

        return START_STICKY
    }

    // Called when user swipes app from recents — schedule restart
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.d(TAG, "Task removed — scheduling restart")
        scheduleRestartAlarm()
        super.onTaskRemoved(rootIntent)
    }

    private fun scheduleRestartAlarm() {
        try {
            val userId = getSavedUserId() ?: return
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
                // Fallback: use inexact alarm
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + 3000,
                    pendingIntent
                )
                Log.d(TAG, "Restart alarm scheduled (inexact) in 3 seconds")
            } else {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + 3000,
                    pendingIntent
                )
                Log.d(TAG, "Restart alarm scheduled (exact) in 3 seconds")
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

    private fun startListening(userId: String) {
        stopListening()
        currentUserId = userId
        seenBuzzIds.clear()
        val db = FirebaseFirestore.getInstance()
        Log.d(TAG, "Starting Firestore listener for userId: $userId")

        buzzListener = db.collection("buzzes")
            .whereEqualTo("to_user_id", userId)
            .whereEqualTo("response", "none")
            .addSnapshotListener { snapshots, error ->
                if (error != null) {
                    Log.e(TAG, "Buzz listener error: ${error.message}")
                    handler.postDelayed({ startListening(userId) }, 5000)
                    return@addSnapshotListener
                }
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

        responseListener = db.collection("buzzes")
            .whereEqualTo("to_user_id", userId)
            .addSnapshotListener { snapshots, error ->
                if (error != null || snapshots == null) return@addSnapshotListener
                for (change in snapshots.documentChanges) {
                    if (change.type == com.google.firebase.firestore.DocumentChange.Type.MODIFIED) {
                        val buzzId = change.document.id
                        val data = change.document.data
                        val response = data["response"] as? String ?: "none"
                        if (response != "none") {
                            Log.d(TAG, "Response detected for $buzzId: $response")
                            stopAlarm()
                            val nm = getSystemService(NotificationManager::class.java)
                            nm.cancel(buzzId.hashCode())
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
            .addOnFailureListener { e -> Log.e(TAG, "Poll failed: ${e.message}") }

        if (seenBuzzIds.size > 50) seenBuzzIds.clear()
    }

    private fun startPolling() {
        handler.removeCallbacks(pollRunnable)
        handler.postDelayed(pollRunnable, POLL_INTERVAL_MS)
    }

    private fun stopPolling() {
        handler.removeCallbacks(pollRunnable)
    }

    private fun showCancelledNotification(buzzId: String, fromUserId: String) {
        val db = FirebaseFirestore.getInstance()
        db.collection("users").document(fromUserId).get()
            .addOnSuccessListener { doc ->
                val senderName = doc.getString("name") ?: "Someone"
                Log.d(TAG, "Showing cancelled notification from $senderName")
                val launchIntent = Intent(this, MainActivity::class.java)
                val pendingIntent = PendingIntent.getActivity(
                    this, (buzzId + "_cancel").hashCode(), launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val notification = NotificationCompat.Builder(this, "openmalo_buzz")
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
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
    }

    private fun cancelActiveBuzzNotification() {
        activeBuzzId?.let { buzzId ->
            val nm = getSystemService(NotificationManager::class.java)
            nm.cancel(buzzId.hashCode())
            activeBuzzId = null
        }
    }

    private fun stopListening() {
        buzzListener?.remove()
        buzzListener = null
        responseListener?.remove()
        responseListener = null
        currentUserId = null
    }

    private fun showBuzzNotification(buzzId: String, fromUserId: String, reason: String, note: String?) {
        val db = FirebaseFirestore.getInstance()
        db.collection("users").document(fromUserId).get()
            .addOnSuccessListener { doc ->
                val senderName = doc.getString("name") ?: "Someone"
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

                val dismissIntent = Intent(this, BuzzerService::class.java).apply {
                    action = ACTION_STOP_ALARM
                }
                val dismissPendingIntent = PendingIntent.getService(
                    this, buzzId.hashCode() + 4, dismissIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                createBuzzChannel()

                val notification = NotificationCompat.Builder(this, "openmalo_buzz")
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
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

    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
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

    private fun createBuzzChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "openmalo_buzz", "Buzzer Alerts",
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

    private fun acquireWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "buzzer::listener").apply {
            acquire()
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
