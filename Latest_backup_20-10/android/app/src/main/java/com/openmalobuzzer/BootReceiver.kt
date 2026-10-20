package com.openmalobuzzer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED ||
            intent?.action == "android.intent.action.QUICKBOOT_POWERON") {
            Log.d("BootReceiver", "Boot completed — restarting BuzzerService")

            val prefs = context.getSharedPreferences(BuzzerService.PREFS_NAME, Context.MODE_PRIVATE)
            val userId = prefs.getString(BuzzerService.PREF_USER_ID, null)

            if (userId != null) {
                val serviceIntent = Intent(context, BuzzerService::class.java).apply {
                    action = BuzzerService.ACTION_START
                    putExtra(BuzzerService.EXTRA_USER_ID, userId)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
                Log.d("BootReceiver", "BuzzerService restarted for userId: $userId")
            } else {
                Log.d("BootReceiver", "No saved userId — skipping service restart")
            }
        }
    }
}
