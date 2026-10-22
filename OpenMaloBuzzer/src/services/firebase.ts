import {supabase} from './supabase';
import {User, Buzz, Reason, BuzzResponse, Group, CallLog, VoiceMail} from '../types';

let channelId = 0;
const uid = () => `ch_${++channelId}_${Date.now()}`;

// ─── Users ───────────────────────────────────────────────
export const getUserName = async (userId: string): Promise<string> => {
  if (!userId) return 'User';
  try {
    const {data} = await supabase.from('users').select('name').eq('id', userId).single();
    return data?.name || 'User';
  } catch {}
  return 'User';
};

export const getUsers = async () => {
  const {data} = await supabase.from('users').select('*').eq('is_active', true);
  return (data || []) as User[];
};

export const getUserByPhone = async (phone: string): Promise<User | null> => {
  const {data} = await supabase
    .from('users').select('*').eq('phone', phone).eq('is_active', true).limit(1).maybeSingle();
  return data ? (data as User) : null;
};

export const updateFcmToken = async (userId: string, token: string) => {
  await supabase.from('user_tokens').upsert({user_id: userId, fcm_token: token, fcm_token_stale: false});
};

export const updateLastSeen = async (userId: string) => {
  await supabase.from('users').update({last_seen_at: Date.now()}).eq('id', userId);
};

export const addUser = async (user: Omit<User, 'id'>) => {
  const {data, error} = await supabase.from('users').insert(user).select().single();
  if (error) throw error;
  return {id: data.id};
};

export const removeUser = async (userId: string) => {
  await supabase.from('users').update({is_active: false}).eq('id', userId);
};

export const removeInactiveByPhone = async (phone: string) => {
  await supabase.from('users').delete().eq('phone', phone).eq('is_active', false);
};

export const resetUserPin = async (userId: string, pinHash: string) => {
  await supabase.from('users').update({pin_hash: pinHash}).eq('id', userId);
};

export const updateUserProfile = async (userId: string, data: {name?: string; phone?: string}) => {
  await supabase.from('users').update(data).eq('id', userId);
};

export const updateUserRole = async (userId: string, role: string) => {
  await supabase.from('users').update({role}).eq('id', userId);
};

export const subscribeToUsers = (callback: (users: User[]) => void) => {
  // Initial fetch
  supabase.from('users').select('*').eq('is_active', true).then(({data}) => {
    if (data) callback(data as User[]);
  });

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: '*', schema: 'public', table: 'users'}, () => {
      supabase.from('users').select('*').eq('is_active', true).then(({data}) => {
        if (data) callback(data as User[]);
      });
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

// ─── Buzzes ──────────────────────────────────────────────
export const createBuzz = async (buzz: Omit<Buzz, 'id'>) => {
  const {data, error} = await supabase.from('buzzes').insert(buzz).select().single();
  if (error) throw error;
  return {id: data.id};
};

export const respondToBuzz = async (buzzId: string, response: BuzzResponse) => {
  await supabase.from('buzzes').update({response, responded_at: Date.now()}).eq('id', buzzId);
};

export const markEscalated = async (buzzId: string) => {
  await supabase.from('buzzes').update({escalated: true}).eq('id', buzzId);
};

export const subscribeToBuzz = (buzzId: string, callback: (buzz: Buzz) => void) => {
  // Initial fetch
  supabase.from('buzzes').select('*').eq('id', buzzId).single().then(({data}) => {
    if (data) callback(data as Buzz);
  });

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: 'UPDATE', schema: 'public', table: 'buzzes', filter: `id=eq.${buzzId}`}, (payload) => {
      callback(payload.new as Buzz);
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

export const getRecentBuzzes = async (userId: string, count = 20) => {
  const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const {data} = await supabase
    .from('buzzes').select('*')
    .eq('from_user_id', userId)
    .gte('created_at', fiveDaysAgo)
    .order('created_at', {ascending: false})
    .limit(count);
  return (data || []) as Buzz[];
};

const PAGE_SIZE = 15;

export const getBuzzLogPage = async (page = 0) => {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const {data} = await supabase
    .from('buzzes').select('*')
    .gte('created_at', since)
    .order('created_at', {ascending: false})
    .range(from, to);

  const buzzes = (data || []) as Buzz[];
  return {
    buzzes,
    lastDoc: page + 1, // next page number
    hasMore: buzzes.length === PAGE_SIZE,
  };
};

// ─── Reasons ─────────────────────────────────────────────
export const getReasons = async () => {
  const {data} = await supabase
    .from('reasons').select('*').eq('is_active', true).order('sort_order');
  return (data || []) as Reason[];
};

export const subscribeToReasons = (callback: (reasons: Reason[]) => void) => {
  supabase.from('reasons').select('*').eq('is_active', true).order('sort_order').then(({data}) => {
    if (data) callback(data as Reason[]);
  });

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: '*', schema: 'public', table: 'reasons'}, () => {
      supabase.from('reasons').select('*').eq('is_active', true).order('sort_order').then(({data}) => {
        if (data) callback(data as Reason[]);
      });
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

export const addReason = async (label: string, sortOrder: number) => {
  await supabase.from('reasons').insert({label, sort_order: sortOrder, is_active: true});
};

export const removeReason = async (reasonId: string) => {
  await supabase.from('reasons').update({is_active: false}).eq('id', reasonId);
};

// ─── Incoming Buzz Listener ──────────────────────────────
export const subscribeToIncomingBuzzes = (
  userId: string,
  callback: (buzz: Buzz) => void,
  onRemoved?: (buzzId: string) => void,
) => {
  let ready = false;
  setTimeout(() => { ready = true; }, 2000);

  // Initial fetch for existing pending buzzes
  supabase.from('buzzes').select('*')
    .eq('to_user_id', userId)
    .eq('response', 'none')
    .then(({data}) => {
      if (data) {
        data.forEach(buzz => {
          if (Date.now() - (buzz as Buzz).created_at < 120000) {
            callback(buzz as Buzz);
          }
        });
      }
    });

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: 'INSERT', schema: 'public', table: 'buzzes', filter: `to_user_id=eq.${userId}`}, (payload) => {
      const buzz = payload.new as Buzz;
      if (buzz.response === 'none' && Date.now() - buzz.created_at < 120000) {
        callback(buzz);
      }
    })
    .on('postgres_changes', {event: 'UPDATE', schema: 'public', table: 'buzzes', filter: `to_user_id=eq.${userId}`}, (payload) => {
      const buzz = payload.new as Buzz;
      if (buzz.response !== 'none' && ready && onRemoved) {
        onRemoved(buzz.id);
      }
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

export const subscribeToNewVoiceMails = (
  userId: string,
  callback: (mail: VoiceMail) => void,
) => {
  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: 'INSERT', schema: 'public', table: 'voice_mails', filter: `to_user_id=eq.${userId}`}, (payload) => {
      const mail = payload.new as VoiceMail;
      if (!mail.listened && !mail.deleted && Date.now() - mail.created_at < 120000) {
        callback(mail);
      }
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

export const subscribeToMissedBuzzes = (
  userId: string,
  callback: (buzzes: Buzz[]) => void,
) => {
  // Initial fetch
  supabase.from('buzzes').select('*').eq('to_user_id', userId).eq('response', 'none').then(({data}) => {
    if (data) callback(data as Buzz[]);
  });

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: '*', schema: 'public', table: 'buzzes', filter: `to_user_id=eq.${userId}`}, () => {
      supabase.from('buzzes').select('*').eq('to_user_id', userId).eq('response', 'none').then(({data}) => {
        if (data) callback(data as Buzz[]);
      });
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

// ─── Groups ─────────────────────────────────────────────
export const subscribeToGroups = (callback: (groups: Group[]) => void) => {
  supabase.from('groups').select('*').eq('is_active', true).then(({data}) => {
    if (data) callback(data as Group[]);
  });

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: '*', schema: 'public', table: 'groups'}, () => {
      supabase.from('groups').select('*').eq('is_active', true).then(({data}) => {
        if (data) callback(data as Group[]);
      });
    })
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

export const createGroup = async (group: Omit<Group, 'id'>) => {
  await supabase.from('groups').insert(group);
};

export const updateGroup = async (groupId: string, data: {name?: string; member_ids?: string[]}) => {
  await supabase.from('groups').update(data).eq('id', groupId);
};

export const deleteGroup = async (groupId: string) => {
  await supabase.from('groups').delete().eq('id', groupId);
};

export const createGroupBuzz = async (
  senderId: string,
  senderName: string,
  memberIds: string[],
  reason: string,
  note: string | null,
  groupId: string,
  groupName: string,
) => {
  const now = Date.now();
  const rows = memberIds.map(memberId => ({
    from_user_id: senderId,
    from_user_name: senderName,
    to_user_id: memberId,
    reason,
    note,
    created_at: now,
    responded_at: null,
    response: 'none',
    escalated: false,
    group_id: groupId,
    group_name: groupName,
  }));

  const {data, error} = await supabase.from('buzzes').insert(rows).select();
  if (error) throw error;
  return (data || []).map((d: any) => ({id: d.id}));
};

// ─── Call Logs ───────────────────────────────────────────
export const addCallLog = async (log: Omit<CallLog, 'id'>) => {
  await supabase.from('call_logs').insert(log);
};

export const getCallLogs = async (userId: string, count = 20) => {
  const {data} = await supabase
    .from('call_logs').select('*')
    .eq('caller_id', userId)
    .order('started_at', {ascending: false})
    .limit(count);
  return (data || []) as CallLog[];
};

// ─── Voice Mails ────────────────────────────────────────
export const addVoiceMail = async (mail: Omit<VoiceMail, 'id'>) => {
  await supabase.from('voice_mails').insert(mail);
};

export const subscribeToVoiceMails = (
  userId: string,
  callback: (mails: VoiceMail[]) => void,
) => {
  const fetchMails = () => {
    supabase.from('voice_mails').select('*')
      .eq('to_user_id', userId)
      .eq('deleted', false)
      .order('created_at', {ascending: false})
      .then(({data}) => {
        if (data) callback(data as VoiceMail[]);
      });
  };

  fetchMails();

  const channel = supabase
    .channel(uid())
    .on('postgres_changes', {event: '*', schema: 'public', table: 'voice_mails', filter: `to_user_id=eq.${userId}`}, fetchMails)
    .subscribe();

  return () => { supabase.removeChannel(channel); };
};

export const markVoiceMailListened = async (mailId: string) => {
  await supabase.from('voice_mails').update({listened: true}).eq('id', mailId);
};

export const deleteVoiceMail = async (mailId: string) => {
  await supabase.from('voice_mails').delete().eq('id', mailId);
};

// ─── FCM (still uses Firebase Messaging) ─────────────────
export const requestFcmPermission = async () => {
  try {
    const {getMessaging, requestPermission} = require('@react-native-firebase/messaging');
    const messaging = getMessaging();
    const status = await requestPermission(messaging);
    return status === 1 || status === 2;
  } catch {
    return false;
  }
};

export const getFcmToken = async () => {
  const {getMessaging, getToken} = require('@react-native-firebase/messaging');
  const messaging = getMessaging();
  return getToken(messaging);
};
