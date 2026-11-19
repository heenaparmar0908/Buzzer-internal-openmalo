const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL")!;
const FIREBASE_PRIVATE_KEY = Deno.env.get("FIREBASE_PRIVATE_KEY")!.replace(/\\n/g, "\n");

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

  // Import the .p8 private key (PKCS#8 PEM format, EC P-256)
  const pemBody = APNS_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

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
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

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
    if (voip_token && platform === "ios" && isBuzz && APNS_KEY_ID) {
      try {
        const apnsJwt = await getApnsToken();
        const voipRes = await fetch(
          `https://api.push.apple.com/3/device/${voip_token}`,
          {
            method: "POST",
            headers: {
              "apns-topic": `${APNS_BUNDLE_ID}.voip`,
              "apns-push-type": "voip",
              "apns-priority": "10",
              "apns-expiration": "0",
              "authorization": `bearer ${apnsJwt}`,
            },
            body: JSON.stringify({
              buzz_id: data.buzz_id,
              from_user_id: data.from_user_id || "",
              from_user_name: data.from_user_name || "User",
              reason: data.reason || "Incoming buzz",
              note: data.note || "",
              sound_id: data.sound_id || "buzz_alarm",
            }),
          }
        );
        if (voipRes.ok) {
          console.log("VoIP push sent — skipping FCM to prevent double notification");
          voipSent = true;
        } else {
          const voipBody = await voipRes.text();
          console.error(`VoIP push failed: HTTP ${voipRes.status} — ${voipBody} — falling through to FCM`);
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
    // If platform is unknown (null/undefined), send a universal message that
    // works on BOTH platforms: notification field (needed for iOS system
    // notification) + android high priority + apns with sound/content-available.
    // This prevents silent failures when the platform column is NULL.
    const isIOS = platform === "ios";
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

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
    const fcmBody = JSON.stringify({ message });
    const fcmHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

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
