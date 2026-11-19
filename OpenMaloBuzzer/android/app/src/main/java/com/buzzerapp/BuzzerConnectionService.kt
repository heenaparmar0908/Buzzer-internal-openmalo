package com.buzzerapp

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.*
import android.util.Log

/**
 * Self-managed ConnectionService — registers incoming buzzes as "calls" with
 * the Android telecom framework. This gives buzzes the same system-level
 * priority that WhatsApp/Instagram voice calls receive:
 *
 *   - Highest audio priority (phone ringer level, not just notification)
 *   - System coordinates with active phone calls (holds/swaps)
 *   - Rings through DND on devices where "calls" are allowed in DND settings
 *   - Better OEM compatibility — OEMs are less likely to suppress phone calls
 *
 * SELF_MANAGED means WE handle the UI (IncomingBuzzScreen), not the system dialer.
 * The system just manages the call lifecycle and audio routing.
 *
 * API 26+ required (CAPABILITY_SELF_MANAGED). Falls back to BuzzerService
 * notification approach on older devices.
 */
class BuzzerConnectionService : ConnectionService() {

    companion object {
        private const val TAG = "BuzzerConnService"
        private const val PHONE_ACCOUNT_ID = "buzzer_incoming"

        fun getPhoneAccountHandle(context: Context): PhoneAccountHandle {
            return PhoneAccountHandle(
                ComponentName(context, BuzzerConnectionService::class.java),
                PHONE_ACCOUNT_ID
            )
        }

        /** Register the self-managed phone account. Safe to call multiple times. */
        fun registerPhoneAccount(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            try {
                val tm = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
                val handle = getPhoneAccountHandle(context)
                val account = PhoneAccount.builder(handle, "Buzzer Alerts")
                    .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                    .build()
                tm.registerPhoneAccount(account)
                Log.d(TAG, "PhoneAccount registered")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to register PhoneAccount: ${e.message}")
            }
        }

        /**
         * Show an incoming buzz as a system-level call.
         * Returns true if the call was successfully added, false if it failed
         * (caller should fall back to BuzzerService.ACTION_SHOW_BUZZ).
         */
        /** Track active buzz to prevent ConnectionService + BuzzerService double-fire. */
        @Volatile var activeConnectionBuzzId: String? = null

        fun showIncomingBuzz(
            context: Context,
            buzzId: String,
            fromUserId: String,
            fromUserName: String,
            reason: String,
            note: String?,
            soundId: String?
        ): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
            // Dedup: if this buzz already has an active connection, skip
            if (activeConnectionBuzzId == buzzId) {
                Log.d(TAG, "Buzz $buzzId already has active connection — skipping")
                return true
            }
            return try {
                activeConnectionBuzzId = buzzId
                val tm = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
                val handle = getPhoneAccountHandle(context)

                val extras = Bundle().apply {
                    putString(BuzzerService.EXTRA_BUZZ_ID, buzzId)
                    putString(BuzzerService.EXTRA_FROM_USER_ID, fromUserId)
                    putString(BuzzerService.EXTRA_FROM_USER_NAME, fromUserName)
                    putString(BuzzerService.EXTRA_REASON, reason)
                    putString(BuzzerService.EXTRA_NOTE, note ?: "")
                    putString(BuzzerService.EXTRA_SOUND_ID, soundId ?: "buzz_alarm")
                }

                tm.addNewIncomingCall(handle, extras)
                Log.d(TAG, "Incoming buzz call added: $buzzId from $fromUserName")
                true
            } catch (e: Exception) {
                Log.e(TAG, "addNewIncomingCall failed: ${e.message}")
                false
            }
        }
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val buzzId = extras.getString(BuzzerService.EXTRA_BUZZ_ID) ?: ""
        val fromUserName = extras.getString(BuzzerService.EXTRA_FROM_USER_NAME) ?: "Buzz"
        val reason = extras.getString(BuzzerService.EXTRA_REASON) ?: ""

        Log.d(TAG, "onCreateIncomingConnection: buzz=$buzzId from=$fromUserName")

        val connection = BuzzerConnection(applicationContext, extras)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            connection.connectionProperties = Connection.PROPERTY_SELF_MANAGED
        }
        connection.setCallerDisplayName(
            "$fromUserName — $reason",
            TelecomManager.PRESENTATION_ALLOWED
        )
        connection.setAddress(
            Uri.parse("tel:buzz"),
            TelecomManager.PRESENTATION_ALLOWED
        )
        connection.setRinging()

        // Also trigger BuzzerService to start the actual alarm (sound + vibration).
        // ConnectionService handles the call lifecycle; BuzzerService handles audio.
        try {
            val intent = Intent(applicationContext, BuzzerService::class.java).apply {
                action = BuzzerService.ACTION_SHOW_BUZZ
                putExtra(BuzzerService.EXTRA_BUZZ_ID, buzzId)
                putExtra(BuzzerService.EXTRA_FROM_USER_ID, extras.getString(BuzzerService.EXTRA_FROM_USER_ID) ?: "")
                putExtra(BuzzerService.EXTRA_FROM_USER_NAME, fromUserName)
                putExtra(BuzzerService.EXTRA_REASON, reason)
                putExtra(BuzzerService.EXTRA_NOTE, extras.getString(BuzzerService.EXTRA_NOTE) ?: "")
                putExtra(BuzzerService.EXTRA_SOUND_ID, extras.getString(BuzzerService.EXTRA_SOUND_ID) ?: "buzz_alarm")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(intent)
            } else {
                applicationContext.startService(intent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start BuzzerService from connection: ${e.message}")
        }

        return connection
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "Incoming connection creation failed — falling back to notification")
        // Fall back to the existing BuzzerService notification approach
        val extras = request?.extras ?: return
        try {
            val intent = Intent(applicationContext, BuzzerService::class.java).apply {
                action = BuzzerService.ACTION_SHOW_BUZZ
                putExtra(BuzzerService.EXTRA_BUZZ_ID, extras.getString(BuzzerService.EXTRA_BUZZ_ID) ?: "")
                putExtra(BuzzerService.EXTRA_FROM_USER_ID, extras.getString(BuzzerService.EXTRA_FROM_USER_ID) ?: "")
                putExtra(BuzzerService.EXTRA_FROM_USER_NAME, extras.getString(BuzzerService.EXTRA_FROM_USER_NAME) ?: "User")
                putExtra(BuzzerService.EXTRA_REASON, extras.getString(BuzzerService.EXTRA_REASON) ?: "")
                putExtra(BuzzerService.EXTRA_NOTE, extras.getString(BuzzerService.EXTRA_NOTE) ?: "")
                putExtra(BuzzerService.EXTRA_SOUND_ID, extras.getString(BuzzerService.EXTRA_SOUND_ID) ?: "buzz_alarm")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(intent)
            } else {
                applicationContext.startService(intent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Fallback to BuzzerService also failed: ${e.message}")
        }
    }
}

/**
 * Represents a single incoming buzz as a "call" in the telecom framework.
 * When the user answers, we open IncomingBuzzScreen. When they reject, we
 * respond with "busy". Auto-disconnects after 2 minutes (matches BuzzerService
 * auto-dismiss timeout).
 */
class BuzzerConnection(
    private val context: Context,
    private val buzzExtras: Bundle
) : Connection() {

    private val buzzId = buzzExtras.getString(BuzzerService.EXTRA_BUZZ_ID) ?: ""
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    init {
        // Auto-disconnect after 2 minutes if no response (matches auto-dismiss)
        handler.postDelayed({
            if (state == STATE_RINGING || state == STATE_ACTIVE) {
                Log.d("BuzzerConnection", "Auto-disconnecting buzz $buzzId after timeout")
                setDisconnected(DisconnectCause(DisconnectCause.MISSED))
                destroy()
            }
        }, 120000)
    }

    override fun onAnswer() {
        Log.d("BuzzerConnection", "Buzz answered: $buzzId")
        setActive()

        // Open the app to IncomingBuzzScreen
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("buzz_id", buzzId)
            putExtra("from_user_id", buzzExtras.getString(BuzzerService.EXTRA_FROM_USER_ID) ?: "")
            putExtra("from_user_name", buzzExtras.getString(BuzzerService.EXTRA_FROM_USER_NAME) ?: "User")
            putExtra("reason", buzzExtras.getString(BuzzerService.EXTRA_REASON) ?: "")
            putExtra("note", buzzExtras.getString(BuzzerService.EXTRA_NOTE) ?: "")
            putExtra("sound_id", buzzExtras.getString(BuzzerService.EXTRA_SOUND_ID) ?: "buzz_alarm")
        }
        context.startActivity(intent)

        // Disconnect the telecom call after a brief delay (the BuzzerService
        // alarm continues independently — we just needed the telecom framework
        // to give us high-priority ringing).
        handler.postDelayed({
            setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
            destroy()
        }, 2000)
    }

    override fun onReject() {
        Log.d("BuzzerConnection", "Buzz rejected: $buzzId")
        BuzzerConnectionService.activeConnectionBuzzId = null
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()

        // Stop the alarm
        try {
            val stopIntent = Intent(context, BuzzerService::class.java).apply {
                action = BuzzerService.ACTION_RESPOND
                putExtra(BuzzerService.EXTRA_BUZZ_ID, buzzId)
                putExtra(BuzzerService.EXTRA_RESPONSE, "busy")
            }
            context.startService(stopIntent)
        } catch (e: Exception) {
            Log.e("BuzzerConnection", "Failed to send busy response: ${e.message}")
        }
    }

    override fun onDisconnect() {
        BuzzerConnectionService.activeConnectionBuzzId = null
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
    }
}
