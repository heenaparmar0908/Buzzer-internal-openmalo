import {SUPABASE_URL, SUPABASE_ANON_KEY} from '@env';
import {supabase} from './supabase';

// Push delivery result — lets the sender UI show appropriate warnings.
export type PushResult = 'delivered' | 'no_token' | 'token_invalid' | 'failed';

/** Check if a token's UNREGISTERED/INVALID error code is present in the FCM response. */
const isTokenInvalid = (body: any): boolean => {
  const code = body?.error?.code;
  const fcmV1Code = body?.error?.details?.find?.(
    (d: any) => d?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
  )?.errorCode;
  return code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    fcmV1Code === 'UNREGISTERED' || fcmV1Code === 'INVALID_ARGUMENT';
};

/** Fire the FCM push via the edge function. Returns the HTTP response. */
const callSendNotification = async (fcmToken: string, platform: string | null, data: Record<string, any>, voipToken?: string | null) => {
  return fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fcm_token: fcmToken,
      platform,
      data,
      ...(voipToken ? {voip_token: voipToken} : {}),
    }),
  });
};

/** Record push attempt result on the buzz row for delivery tracking. */
const trackPush = (buzzId: string, result: PushResult, attempts: number) => {
  Promise.resolve(supabase.from('buzzes').update({
    push_sent_at: Date.now(),
    push_result: result,
    push_attempts: attempts,
  }).eq('id', buzzId)).catch(() => {});
};

export const sendBuzzPush = async (
  toUserId: string,
  buzzId: string,
  fromUserId: string,
  fromUserName: string,
  reason: string,
  note: string | null,
  soundId: string = 'buzz_alarm',
): Promise<PushResult> => {
  try {
    // Query token data. voip_token may not exist yet (migration 008 not run),
    // so catch column-not-found and retry without it.
    let tokenData: any = null;
    const {data: td, error: tokenErr} = await supabase
      .from('user_tokens').select('fcm_token,fcm_token_stale,token_updated_at,platform,voip_token').eq('user_id', toUserId).maybeSingle();
    if (tokenErr && tokenErr.code === '42703') {
      // voip_token column doesn't exist yet — query without it
      const {data: td2} = await supabase
        .from('user_tokens').select('fcm_token,fcm_token_stale,token_updated_at,platform').eq('user_id', toUserId).maybeSingle();
      tokenData = td2;
    } else {
      tokenData = td;
    }
    const fcmToken = tokenData?.fcm_token;
    const voipToken = tokenData?.voip_token || null;
    // Only bail if BOTH tokens are missing. VoIP push can deliver
    // even when FCM token is null (e.g., APNs registration failed
    // but PushKit succeeded — common on first launch).
    if (!fcmToken && !voipToken) { trackPush(buzzId, 'no_token', 0); return 'no_token'; }

    // If token was marked stale but has been refreshed since (user opened app),
    // clear the stale flag and attempt delivery. Without this, a user who
    // refreshed their token would still be unreachable until someone else
    // successfully pushes to them first.
    if (fcmToken && tokenData?.fcm_token_stale) {
      const updatedAt = tokenData?.token_updated_at || 0;
      const staleAge = Date.now() - updatedAt;
      // Token was refreshed in the last 7 days — the stale flag is outdated
      if (updatedAt > 0 && staleAge < 7 * 24 * 60 * 60 * 1000) {
        console.log(`[Push] Token was stale but refreshed ${Math.round(staleAge / 60000)}m ago — clearing stale flag`);
        await supabase.from('user_tokens').update({fcm_token_stale: false}).eq('user_id', toUserId);
      } else {
        // Token stale for >7 days — still attempt delivery. The token may
        // have been refreshed by a background task without clearing the flag.
        // If FCM returns UNREGISTERED, we'll re-mark it stale below.
        console.log(`[Push] Token stale for ${Math.round(staleAge / 86400000)}d — attempting delivery anyway`);
      }
    }

    const payload = {
      type: 'buzz',
      buzz_id: buzzId,
      from_user_id: fromUserId,
      from_user_name: fromUserName,
      reason,
      note: note || '',
      sound_id: soundId,
    };

    // Retry up to 5 times with increasing delays (1s, 2s, 3s, 4s).
    // Intermittent failures (edge function cold start, network hiccup)
    // are resolved by retrying. Permanent errors (UNREGISTERED) stop immediately.
    const MAX_ATTEMPTS = 5;
    let attempt = 0;
    let lastRes: Response | null = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      if (attempt > 1) {
        await new Promise<void>(r => setTimeout(r, (attempt - 1) * 1000));
      }
      try {
        lastRes = await callSendNotification(fcmToken || '', tokenData?.platform || null, payload, voipToken);
        let body: any = {};
        try { body = await lastRes.json(); } catch {}

        if (fcmToken && isTokenInvalid(body)) {
          await supabase.from('user_tokens').update({fcm_token_stale: true}).eq('user_id', toUserId);
          trackPush(buzzId, 'token_invalid', attempt);
          return 'token_invalid';
        }

        if (lastRes.ok) {
          trackPush(buzzId, 'delivered', attempt);
          return 'delivered';
        }

        console.log(`[Push] Attempt ${attempt}/${MAX_ATTEMPTS} failed (HTTP ${lastRes.status})`);
      } catch (e: any) {
        console.log(`[Push] Attempt ${attempt}/${MAX_ATTEMPTS} error: ${e?.message}`);
      }
    }

    trackPush(buzzId, 'failed', attempt);
    return 'failed';
  } catch (e: any) {
    console.warn('sendBuzzPush failed:', e?.message || e);
    trackPush(buzzId, 'failed', 0);
    return 'failed';
  }
};

export const sendBuzzCancelledPush = async (
  toUserId: string,
  buzzId: string,
  fromUserName: string,
) => {
  try {
    const {data: tokenData} = await supabase
      .from('user_tokens').select('fcm_token,fcm_token_stale,platform').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken || tokenData?.fcm_token_stale) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
        platform: tokenData?.platform || null,
        data: {
          type: 'buzz_cancelled',
          buzz_id: buzzId,
          from_user_name: fromUserName,
        },
      }),
    });
  } catch (e: any) {
    console.warn('sendBuzzCancelledPush failed:', e?.message || e);
  }
};

export const sendVoiceMailPush = async (
  toUserId: string,
  fromUserName: string,
  duration: number,
) => {
  try {
    const {data: tokenData} = await supabase
      .from('user_tokens').select('fcm_token,fcm_token_stale,platform').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken || tokenData?.fcm_token_stale) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
        platform: tokenData?.platform || null,
        data: {
          type: 'voice_message',
          from_user_name: fromUserName,
          duration: String(duration),
        },
      }),
    });
  } catch (e: any) {
    console.warn('sendVoiceMailPush failed:', e?.message || e);
  }
};

export const sendEscalationPush = async (
  toUserId: string,
  buzzId: string,
  fromUserId: string,
  fromUserName: string,
  reason: string,
  note: string | null,
  soundId: string = 'buzz_alarm',
) => {
  try {
    const {data: tokenData} = await supabase
      .from('user_tokens').select('fcm_token,fcm_token_stale,platform').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken || tokenData?.fcm_token_stale) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
        platform: tokenData?.platform || null,
        data: {
          type: 'buzz',
          buzz_id: buzzId,
          from_user_id: fromUserId,
          from_user_name: fromUserName,
          reason: `RE-BUZZ: ${reason}`,
          note: note || '',
          sound_id: soundId,
        },
      }),
    });
  } catch (e: any) {
    console.warn('sendEscalationPush failed:', e?.message || e);
  }
};
