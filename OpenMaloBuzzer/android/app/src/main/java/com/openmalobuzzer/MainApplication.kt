package com.openmalobuzzer

import android.app.Application
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import java.util.concurrent.TimeUnit

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(BuzzerServicePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    scheduleTokenRefresh()
  }

  private fun scheduleTokenRefresh() {
    try {
      val workRequest = PeriodicWorkRequestBuilder<TokenRefreshWorker>(
        6, TimeUnit.HOURS
      ).build()

      WorkManager.getInstance(this).enqueueUniquePeriodicWork(
        TokenRefreshWorker.WORK_NAME,
        ExistingPeriodicWorkPolicy.KEEP,
        workRequest
      )
      Log.d("MainApplication", "TokenRefreshWorker scheduled (every 6 hours)")
    } catch (e: Exception) {
      Log.e("MainApplication", "Failed to schedule TokenRefreshWorker: ${e.message}")
    }
  }
}
