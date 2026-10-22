package com.openmalobuzzer

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

class TokenRefreshWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        const val TAG = "TokenRefreshWorker"
        const val WORK_NAME = "token_refresh_work"
    }

    override suspend fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences(
            BuzzerService.PREFS_NAME, Context.MODE_PRIVATE
        )
        val userId = prefs.getString(BuzzerService.PREF_USER_ID, null)
        if (userId == null) {
            Log.d(TAG, "No saved userId — skipping")
            return Result.success()
        }

        Log.d(TAG, "Running periodic token refresh for userId: $userId")

        try {
            // Refresh FCM token and save to Supabase
            val token = FirebaseMessaging.getInstance().token.await()
            if (!token.isNullOrEmpty()) {
                val url = URL("${SupabaseConfig.URL}/rest/v1/user_tokens")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("apikey", SupabaseConfig.ANON_KEY)
                conn.setRequestProperty("Authorization", "Bearer ${SupabaseConfig.ANON_KEY}")
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Prefer", "resolution=merge-duplicates,return=minimal")
                conn.doOutput = true

                val body = JSONObject().apply {
                    put("user_id", userId)
                    put("fcm_token", token)
                    put("fcm_token_stale", false)
                }

                val writer = OutputStreamWriter(conn.outputStream)
                writer.write(body.toString())
                writer.flush()
                writer.close()
                conn.responseCode
                conn.disconnect()

                Log.d(TAG, "FCM token refreshed and saved to Supabase")
            }

            // Restart BuzzerService if not running
            try {
                val serviceIntent = Intent(applicationContext, BuzzerService::class.java).apply {
                    action = BuzzerService.ACTION_START
                    putExtra(BuzzerService.EXTRA_USER_ID, userId)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    applicationContext.startForegroundService(serviceIntent)
                } else {
                    applicationContext.startService(serviceIntent)
                }
                Log.d(TAG, "BuzzerService restart requested")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to restart BuzzerService: ${e.message}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Token refresh failed: ${e.message}")
            return Result.retry()
        }

        return Result.success()
    }
}
