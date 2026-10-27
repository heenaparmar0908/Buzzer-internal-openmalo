# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# Keep BuzzerService and its companion (used via reflection by React Native NativeModules)
-keep class com.openmalobuzzer.BuzzerService { *; }
-keep class com.openmalobuzzer.BuzzerService$Companion { *; }
-keep class com.openmalobuzzer.BuzzerServiceModule { *; }
-keep class com.openmalobuzzer.BuzzerServicePackage { *; }
-keep class com.openmalobuzzer.BootReceiver { *; }
-keep class com.openmalobuzzer.TokenRefreshWorker { *; }
-keep class com.openmalobuzzer.OemBatteryHelper { *; }
-keep class com.openmalobuzzer.OemBatteryHelper$* { *; }
-keep class com.openmalobuzzer.SupabaseConfig { *; }
-keep class com.openmalobuzzer.MainActivity { *; }

# Keep BuildConfig fields used by SupabaseConfig
-keep class com.openmalobuzzer.BuildConfig { *; }

# Firebase Messaging
-keep class com.google.firebase.messaging.** { *; }
-dontwarn com.google.firebase.messaging.**

# Supabase REST — keep JSON model classes
-keepattributes *Annotation*
-keep class org.json.** { *; }

# WorkManager
-keep class androidx.work.** { *; }
