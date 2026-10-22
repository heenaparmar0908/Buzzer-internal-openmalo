import {SUPABASE_URL, SUPABASE_ANON_KEY} from '@env';
import {supabase} from './supabase';

export const sendBuzzPush = async (
  toUserId: string,
  buzzId: string,
  fromUserId: string,
  fromUserName: string,
  reason: string,
  note: string | null,
) => {
  try {
    const {data: tokenData} = await supabase
      .from('user_tokens').select('fcm_token').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
        data: {
          type: 'buzz',
          buzz_id: buzzId,
          from_user_id: fromUserId,
          from_user_name: fromUserName,
          reason,
          note: note || '',
        },
      }),
    });
  } catch (e: any) {
    console.warn('sendBuzzPush failed:', e?.message || e);
  }
};

export const sendBuzzCancelledPush = async (
  toUserId: string,
  buzzId: string,
  fromUserName: string,
) => {
  try {
    const {data: tokenData} = await supabase
      .from('user_tokens').select('fcm_token').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
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
      .from('user_tokens').select('fcm_token').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
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
) => {
  try {
    const {data: tokenData} = await supabase
      .from('user_tokens').select('fcm_token').eq('user_id', toUserId).maybeSingle();
    const fcmToken = tokenData?.fcm_token;
    if (!fcmToken) return;

    await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fcm_token: fcmToken,
        data: {
          type: 'buzz',
          buzz_id: buzzId,
          from_user_id: fromUserId,
          from_user_name: fromUserName,
          reason: `RE-BUZZ: ${reason}`,
          note: note || '',
        },
      }),
    });
  } catch (e: any) {
    console.warn('sendEscalationPush failed:', e?.message || e);
  }
};
