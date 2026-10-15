package com.openmalobuzzer

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  companion object {
    var pendingBuzzPayload: Bundle? = null
  }

  override fun getMainComponentName(): String = "OpenMaloBuzzer"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleBuzzIntent(intent)
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    intent?.let { handleBuzzIntent(it) }
  }

  private fun handleBuzzIntent(intent: Intent) {
    val buzzId = intent.getStringExtra("buzz_id") ?: return
    pendingBuzzPayload = Bundle().apply {
      putString("buzz_id", buzzId)
      putString("from_user_id", intent.getStringExtra("from_user_id") ?: "")
      putString("from_user_name", intent.getStringExtra("from_user_name") ?: "Someone")
      putString("reason", intent.getStringExtra("reason") ?: "")
      putString("note", intent.getStringExtra("note") ?: "")
    }
    // Clear the extras so we don't re-process
    intent.removeExtra("buzz_id")
  }
}
