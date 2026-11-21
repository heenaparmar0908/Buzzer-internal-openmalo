const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL")!;
const _RAW_KEY = Deno.env.get("FIREBASE_PRIVATE_KEY") || "";
const FIREBASE_PRIVATE_KEY = _RAW_KEY.replace(/\\n/g, "\n");

// APNs auth for VoIP pushes (PushKit/CallKit).
// These come from your Apple Developer account → Keys → APNs Auth Key (.p8).
// Set them as Supabase Edge Function secrets:
//   supabase secrets set APNS_KEY_ID=ABC123DEFG
//   supabase secrets set APNS_TEAM_ID=TEAM123456
//   supabase secrets set APNS_PRIVATE_KEY="$(cat AuthKey_ABC123DEFG.p8)"
//   supabase secrets set APNS_BUNDLE_ID=com.openmalobuzzer
const APNS_KEY_ID = Deno.env.get("APNS_KEY_ID") || "";
const APNS_TEAM_ID = Deno.env.get("APNS_TEAM_ID") || "";
const APNS_PRIVATE_KEY = (Deno.env.get("APNS_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
const APNS_BUNDLE_ID = Deno.env.get("APNS_BUNDLE_ID") || "com.openmalobuzzer";

function base64url(data: Uint8Array | string): string {
  const str =
    typeof data === "string"
      ? btoa(data)
      : btoa(String.fromCharCode(...data));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate an APNs JWT for VoIP push authentication.
 * Apple requires ES256 (ECDSA with P-256 curve) — different from Google's RS256.
 * The token is valid for up to 1 hour per Apple's docs.
 *
 * Required secrets: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (the .p8 file content)
 */
async function getApnsToken(): Promise<string> {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY) {
    throw new Error("APNs secrets not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY)");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID, typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }));
  const signInput = new TextEncoder().encode(`${header}.${claims}`);

  // Import the .p8 private key (PKCS#8 PEM format, EC P-256).
  // Supabase secrets may strip newlines or add spaces, so clean thoroughly.
  let pemBody = APNS_PRIVATE_KEY;
  // Remove PEM headers/footers
  pemBody = pemBody.replace(/-----BEGIN PRIVATE KEY-----/g, "");
  pemBody = pemBody.replace(/-----END PRIVATE KEY-----/g, "");
  // Remove ALL whitespace (newlines, spaces, tabs)
  pemBody = pemBody.replace(/[\s\r\n]+/g, "");

  let keyData: Uint8Array;
  try {
    keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  } catch (e) {
    throw new Error(`Failed to decode APNs key base64: ${e}. Key length=${pemBody.length}`);
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  } catch (e) {
    throw new Error(`Failed to import APNs key: ${e}. keyData length=${keyData.length} bytes`);
  }

  const sigBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signInput
  );

  // WebCrypto returns ECDSA signatures in IEEE P1363 format (r||s, 64 bytes for P-256).
  // APNs (which uses JWS/JWT) expects this same format in base64url — no DER conversion needed.
  const signature = base64url(new Uint8Array(sigBuffer));
  return `${header}.${claims}.${signature}`;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: FIREBASE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );

  const signInput = new TextEncoder().encode(`${header}.${claims}`);

  const pemBody = FIREBASE_PRIVATE_KEY.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g,
    ""
  ).replace(/\s/g, "");

  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  // Diagnostic: log key details to find why it suddenly broke
  console.log(`[KEY-DIAG] RAW_KEY length=${_RAW_KEY.length}, has-BEGIN=${_RAW_KEY.includes("BEGIN")}, has-backslash-n=${_RAW_KEY.includes("\\n")}, has-real-newline=${_RAW_KEY.includes("\n")}`);
  console.log(`[KEY-DIAG] AFTER_REPLACE length=${FIREBASE_PRIVATE_KEY.length}, has-BEGIN=${FIREBASE_PRIVATE_KEY.includes("BEGIN")}`);
  console.log(`[KEY-DIAG] pemBody length=${pemBody.length}, first8=${pemBody.substring(0,8)}, last8=${pemBody.substring(pemBody.length-8)}`);
  console.log(`[KEY-DIAG] keyData bytes=${keyData.length}`);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8", keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["sign"]
    );
  } catch (e) {
    throw new Error(`Firebase key import failed: ${e}. pemBody=${pemBody.length}chars, keyData=${keyData.length}bytes, first8=${pemBody.substring(0,8)}`);
  }

  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signInput)
  );

  const jwt = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  let tokenData: any;
  try {
    tokenData = await res.json();
  } catch (parseErr) {
    throw new Error(`OAuth2 response parse failed (HTTP ${res.status}): ${parseErr}`);
  }
  if (!tokenData.access_token) {
    throw new Error(`OAuth2 error: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      },
    });
  }

  try {
    const { fcm_token, voip_token, data, platform } = await req.json();
    if (!fcm_token && !voip_token) {
      return new Response(JSON.stringify({ error: "Missing fcm_token or voip_token" }), {
        status: 400,
      });
    }

    // iOS VoIP push via APNs (CallKit — WhatsApp-style guaranteed delivery).
    // VoIP pushes are sent DIRECTLY to APNs using Apple's ES256 JWT auth,
    // not through FCM, because FCM doesn't support PushKit tokens.
    // If voip_token is provided for iOS buzz, send VoIP push first,
    // then fall through to FCM as backup notification.
    // iOS VoIP push via APNs (CallKit — WhatsApp-style guaranteed delivery).
    // If VoIP push succeeds, SKIP FCM to prevent double notification/sound.
    // Only fall through to FCM if VoIP fails.
    const isBuzz = data?.type === "buzz";
    let voipSent = false;
    // Use voip_token presence as the signal (not platform column) because
    // platform may be NULL if the column was missing when the token was saved.
    if (voip_token && isBuzz && APNS_KEY_ID) {
      try {
        const apnsJwt = await getApnsToken();
        const voipPayload = JSON.stringify({
          buzz_id: data.buzz_id,
          from_user_id: data.from_user_id || "",
          from_user_name: data.from_user_name || "User",
          reason: data.reason || "Incoming buzz",
          note: data.note || "",
          sound_id: data.sound_id || "buzz_alarm",
        });
        const apnsHeaders = {
          "apns-topic": `${APNS_BUNDLE_ID}.voip`,
          "apns-push-type": "voip",
          "apns-priority": "10",
          "apns-expiration": "0",
          "authorization": `bearer ${apnsJwt}`,
        };

        // Send to BOTH production and sandbox APNs in parallel.
        // Debug builds use sandbox tokens, release builds use production.
        // Instead of trying production first (slow on BadDeviceToken),
        // fire both and use whichever succeeds.
        const [prodRes, sandboxRes] = await Promise.allSettled([
          fetch(`https://api.push.apple.com/3/device/${voip_token}`, {
            method: "POST", headers: apnsHeaders, body: voipPayload,
          }),
          fetch(`https://api.sandbox.push.apple.com/3/device/${voip_token}`, {
            method: "POST", headers: apnsHeaders, body: voipPayload,
          }),
        ]);

        let prodOk = prodRes.status === "fulfilled" && prodRes.value.ok;
        let sandboxOk = sandboxRes.status === "fulfilled" && sandboxRes.value.ok;

        // Retry once if both failed (transient network/APNs issue)
        if (!prodOk && !sandboxOk) {
          console.log("VoIP attempt 1 failed on both — retrying in 1s...");
          await new Promise(r => setTimeout(r, 1000));
          const [prodRes2, sandboxRes2] = await Promise.allSettled([
            fetch(`https://api.push.apple.com/3/device/${voip_token}`, {
              method: "POST", headers: apnsHeaders, body: voipPayload,
            }),
            fetch(`https://api.sandbox.push.apple.com/3/device/${voip_token}`, {
              method: "POST", headers: apnsHeaders, body: voipPayload,
            }),
          ]);
          prodOk = prodRes2.status === "fulfilled" && prodRes2.value.ok;
          sandboxOk = sandboxRes2.status === "fulfilled" && sandboxRes2.value.ok;
        }

        if (prodOk || sandboxOk) {
          console.log(`VoIP push sent (prod=${prodOk}, sandbox=${sandboxOk}) — skipping FCM`);
          voipSent = true;
        } else {
          const prodErr = prodRes.status === "fulfilled" ? `HTTP ${prodRes.value.status}` : prodRes.reason;
          const sandboxErr = sandboxRes.status === "fulfilled" ? `HTTP ${sandboxRes.value.status}` : sandboxRes.reason;
          console.error(`VoIP push failed after retry: prod=${prodErr}, sandbox=${sandboxErr} — falling through to FCM`);
        }
      } catch (voipErr) {
        console.error("VoIP push error — falling through to FCM:", voipErr);
      }
    }

    // If VoIP succeeded, return early — no FCM needed (prevents double sound)
    if (voipSent) {
      return new Response(JSON.stringify({ success: true, voip: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!fcm_token) {
      return new Response(JSON.stringify({ success: true, voip_only: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken();
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
    const fcmHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // Android buzz: send data-only HIGH priority FIRST, before notification+data.
    // When the app has been killed (10+ days inactive), notification+data messages
    // are displayed by the SYSTEM (no app code runs) → one-time sound only.
    // A data-only message triggers setBackgroundMessageHandler → BuzzerService
    // starts with continuous alarm, full-screen intent, and ConnectionService.
    // The notification+data below acts as a FALLBACK if the OEM drops data-only.
    // BuzzerService.cancelAllNotificationsForBuzz deduplicates if both arrive.
    const isIOS = platform === "ios";
    if (!isIOS && isBuzz && fcm_token) {
      try {
        const dataOnlyMsg = { token: fcm_token, data: data || {}, android: { priority: "high" } };
        const dRes = await fetch(fcmUrl, { method: "POST", headers: fcmHeaders, body: JSON.stringify({ message: dataOnlyMsg }) });
        if (dRes.ok) {
          console.log("Android data-only FCM sent → background handler will start alarm");
        } else {
          console.log(`Android data-only FCM failed HTTP ${dRes.status} — notification+data fallback follows`);
        }
      } catch (e) {
        console.error("Android data-only FCM error:", e);
      }
    }

    // If platform is unknown (null/undefined), send a universal message that
    // works on BOTH platforms: notification field (needed for iOS system
    // notification) + android high priority + apns with sound/content-available.
    // This prevents silent failures when the platform column is NULL.
    const isUnknown = !platform;

    // Build alert text
    const alertTitle = data?.type === "buzz"
      ? `Buzz from ${data?.from_user_name || "User"}`
      : data?.type === "voice_message"
      ? `Voice message from ${data?.from_user_name || "User"}`
      : data?.type === "buzz_cancelled"
      ? "Buzz cancelled"
      : undefined;
    const alertBody = data?.type === "buzz"
      ? (data?.reason || "Incoming buzz")
      : data?.type === "voice_message"
      ? `${data?.duration || "0"}s voice message`
      : data?.type === "buzz_cancelled"
      ? `${data?.from_user_name || "User"} cancelled the buzz`
      : undefined;

    // Build FCM message with BOTH notification + data fields.
    //
    // WHY: Data-only messages require our background handler to run, which
    // fails when Android OEMs (Xiaomi, Huawei, Samsung) restrict the app
    // or after long inactivity. WhatsApp/Telegram use notification messages
    // which the SYSTEM displays automatically — no app code needed.
    //
    // BEHAVIOR:
    //   Foreground: onMessage receives both → our code handles it (full alarm)
    //   Background/Killed: system shows notification with channel sound →
    //     user taps → app opens → IncomingBuzzScreen with full alarm
    //   Service alive: native polling catches buzz 0-10s later → full alarm
    //
    // EXCEPTION: buzz_cancelled stays data-only so our handler can cancel
    //   the original notification and stop the alarm.
    const message: Record<string, any> = {
      token: fcm_token,
      data: data || {},
    };

    const isBuzzOrVoice = data?.type === "buzz" || data?.type === "voice_message";
    const isCancellation = data?.type === "buzz_cancelled";
    const buzzSoundName = data?.sound_id || "buzz_alarm";

    // --- Notification field (system-displayed, like WhatsApp) ---
    // Added for buzz and voice_message types on ALL platforms.
    // Cancellations stay data-only so the handler can cancel the notification.
    if (isBuzzOrVoice && alertTitle) {
      message.notification = {
        title: alertTitle,
        body: alertBody,
      };
    }

    // --- Android-specific overrides ---
    if (!isIOS) {
      message.android = {
        priority: "high",
        ...(isBuzzOrVoice ? {
          notification: {
            channel_id: data?.type === "buzz" ? "buzzer_alerts" : "buzzer_voicemail",
            sound: data?.type === "buzz" ? buzzSoundName : "default",
            default_vibrate_timings: false,
            vibrate_timings: ["0s", "0.500s", "0.200s", "0.500s", "0.200s", "0.500s"],
            notification_count: 1,
            // Tag allows cancellation to find and remove this notification
            ...(data?.buzz_id ? { tag: data.buzz_id } : {}),
          },
        } : {}),
      };
    }

    // --- APNs/iOS overrides ---
    message.apns = {
      headers: {
        "apns-priority": "10",
        "apns-push-type": isCancellation ? "background" : "alert",
        ...(data?.buzz_id ? { "apns-collapse-id": data.buzz_id } : {}),
      },
      payload: {
        aps: {
          ...(alertTitle ? { alert: { title: alertTitle, body: alertBody } } : {}),
          ...(data?.type === "buzz" ? {
            sound: `${buzzSoundName}.wav`,
            "interruption-level": "time-sensitive",
            "category": "buzz_actions",
          } : data?.type === "voice_message" ? {
            sound: "default",
          } : {}),
          ...(isCancellation ? { "content-available": 1 } : {}),
        },
      },
    };

    const fcmBody = JSON.stringify({ message });

    // Helper to extract FCM-specific error code from v1 response
    const getFcmErrorCode = (body: any): string | undefined =>
      body?.error?.details?.find(
        (d: any) => d["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError"
      )?.errorCode;

    let fcmRes = await fetch(fcmUrl, { method: "POST", headers: fcmHeaders, body: fcmBody });
    let result = await fcmRes.json();

    // Retry ONCE on transient server errors (429, 500, 503).
    // FCM notification messages are idempotent — Google deduplicates by message content.
    // Permanent errors (UNREGISTERED, INVALID_ARGUMENT, 400, 401) are NOT retried.
    if (!fcmRes.ok && fcmRes.status >= 429 && !getFcmErrorCode(result)) {
      // Wait 1-2s before retry (respect Retry-After if present)
      const retryAfter = parseInt(fcmRes.headers.get("Retry-After") || "2", 10);
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000));
      fcmRes = await fetch(fcmUrl, { method: "POST", headers: fcmHeaders, body: fcmBody });
      result = await fcmRes.json();
    }

    // Detect stale/expired FCM tokens from FCM v1 error format and return
    // a structured error the client can easily match.
    if (!fcmRes.ok) {
      const fcmErrorCode = getFcmErrorCode(result);
      if (fcmErrorCode === "UNREGISTERED" || fcmErrorCode === "INVALID_ARGUMENT") {
        return new Response(JSON.stringify({
          error: {
            code: fcmErrorCode === "UNREGISTERED"
              ? "messaging/registration-token-not-registered"
              : "messaging/invalid-registration-token",
          },
        }), {
          status: 410,  // Gone — token is no longer valid
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify(result), {
      status: fcmRes.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
