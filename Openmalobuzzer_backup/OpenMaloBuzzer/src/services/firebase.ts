import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  startAfter,
  getDocs,
  doc,
  addDoc,
  updateDoc,
  setDoc,
  onSnapshot,
} from '@react-native-firebase/firestore';
import {COLLECTIONS} from '../constants';
import {User, Buzz, Reason, BuzzResponse, Group, CallLog, VoiceMail} from '../types';

const db = getFirestore();

// ─── Users ───────────────────────────────────────────────
export const getUsers = () =>
  getDocs(
    query(collection(db, COLLECTIONS.USERS), where('is_active', '==', true)),
  ).then(snap => snap.docs.map(d => ({id: d.id, ...d.data()} as User)));

export const getUserByPhone = async (phone: string): Promise<User | null> => {
  const snap = await getDocs(
    query(
      collection(db, COLLECTIONS.USERS),
      where('phone', '==', phone),
      where('is_active', '==', true),
      firestoreLimit(1),
    ),
  );
  if (snap.empty) return null;
  return {id: snap.docs[0].id, ...snap.docs[0].data()} as User;
};

export const updateFcmToken = (userId: string, token: string) =>
  setDoc(doc(db, COLLECTIONS.USER_TOKENS, userId), {fcm_token: token});

export const updateLastSeen = (userId: string) =>
  updateDoc(doc(db, COLLECTIONS.USERS, userId), {last_seen_at: Date.now()});

export const addUser = (user: Omit<User, 'id'>) =>
  addDoc(collection(db, COLLECTIONS.USERS), user);

export const removeUser = (userId: string) =>
  updateDoc(doc(db, COLLECTIONS.USERS, userId), {is_active: false});

export const resetUserPin = (userId: string, pinHash: string) =>
  updateDoc(doc(db, COLLECTIONS.USERS, userId), {pin_hash: pinHash});

export const updateUserProfile = (userId: string, data: {name?: string; phone?: string}) =>
  updateDoc(doc(db, COLLECTIONS.USERS, userId), data);

export const updateUserRole = (userId: string, role: string) =>
  updateDoc(doc(db, COLLECTIONS.USERS, userId), {role});

export const subscribeToUsers = (callback: (users: User[]) => void) =>
  onSnapshot(
    query(collection(db, COLLECTIONS.USERS), where('is_active', '==', true)),
    snap => {
      if (!snap) return;
      callback(snap.docs.map(d => ({id: d.id, ...d.data()} as User)));
    },
    err => console.warn('subscribeToUsers error:', err),
  );

// ─── Buzzes ──────────────────────────────────────────────
export const createBuzz = (buzz: Omit<Buzz, 'id'>) =>
  addDoc(collection(db, COLLECTIONS.BUZZES), buzz);

export const respondToBuzz = (buzzId: string, response: BuzzResponse) =>
  updateDoc(doc(db, COLLECTIONS.BUZZES, buzzId), {
    response,
    responded_at: Date.now(),
  });

export const markEscalated = (buzzId: string) =>
  updateDoc(doc(db, COLLECTIONS.BUZZES, buzzId), {escalated: true});

export const subscribeToBuzz = (buzzId: string, callback: (buzz: Buzz) => void) =>
  onSnapshot(
    doc(db, COLLECTIONS.BUZZES, buzzId),
    snap => {
      if (!snap || !snap.exists()) return;
      callback({id: snap.id, ...snap.data()} as Buzz);
    },
    err => console.warn('subscribeToBuzz error:', err),
  );

export const getRecentBuzzes = (userId: string, count = 20) =>
  getDocs(
    query(
      collection(db, COLLECTIONS.BUZZES),
      where('from_user_id', '==', userId),
      orderBy('created_at', 'desc'),
      firestoreLimit(count),
    ),
  ).then(snap => snap.docs.map(d => ({id: d.id, ...d.data()} as Buzz)));

const PAGE_SIZE = 15;

export const getBuzzLogPage = async (lastDoc?: any) => {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
  const constraints: any[] = [
    where('created_at', '>=', since),
    orderBy('created_at', 'desc'),
    firestoreLimit(PAGE_SIZE),
  ];
  if (lastDoc) {
    constraints.push(startAfter(lastDoc));
  }
  const snap = await getDocs(
    query(collection(db, COLLECTIONS.BUZZES), ...constraints),
  );
  return {
    buzzes: snap.docs.map(d => ({id: d.id, ...d.data()} as Buzz)),
    lastDoc: snap.docs[snap.docs.length - 1] || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
};

// ─── Reasons ─────────────────────────────────────────────
export const getReasons = () =>
  getDocs(
    query(
      collection(db, COLLECTIONS.REASONS),
      where('is_active', '==', true),
      orderBy('sort_order'),
    ),
  ).then(snap => snap.docs.map(d => ({id: d.id, ...d.data()} as Reason)));

export const subscribeToReasons = (callback: (reasons: Reason[]) => void) =>
  onSnapshot(
    query(
      collection(db, COLLECTIONS.REASONS),
      where('is_active', '==', true),
      orderBy('sort_order'),
    ),
    snap => {
      if (!snap) return;
      callback(snap.docs.map(d => ({id: d.id, ...d.data()} as Reason)));
    },
    err => console.warn('subscribeToReasons error:', err),
  );

export const addReason = (label: string, sortOrder: number) =>
  addDoc(collection(db, COLLECTIONS.REASONS), {
    label,
    sort_order: sortOrder,
    is_active: true,
  });

export const removeReason = (reasonId: string) =>
  updateDoc(doc(db, COLLECTIONS.REASONS, reasonId), {is_active: false});

// ─── Incoming Buzz Listener ──────────────────────────────
export const subscribeToIncomingBuzzes = (
  userId: string,
  callback: (buzz: Buzz) => void,
  onRemoved?: (buzzId: string) => void,
) => {
  let isFirstSnapshot = true;
  return onSnapshot(
    query(
      collection(db, COLLECTIONS.BUZZES),
      where('to_user_id', '==', userId),
      where('response', '==', 'none'),
    ),
    snap => {
      if (!snap) return;
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          const buzz = {id: change.doc.id, ...change.doc.data()} as Buzz;
          // Only alert for buzzes created in the last 2 minutes
          if (Date.now() - buzz.created_at < 120000) {
            callback(buzz);
          }
        }
        if (change.type === 'removed' && !isFirstSnapshot && onRemoved) {
          onRemoved(change.doc.id);
        }
      });
      isFirstSnapshot = false;
    },
    err => console.warn('subscribeToIncomingBuzzes error:', err),
  );
};

// ─── Groups ─────────────────────────────────────────────
export const subscribeToGroups = (callback: (groups: Group[]) => void) =>
  onSnapshot(
    query(collection(db, COLLECTIONS.GROUPS), where('is_active', '==', true)),
    snap => {
      if (!snap) return;
      callback(snap.docs.map(d => ({id: d.id, ...d.data()} as Group)));
    },
    err => console.warn('subscribeToGroups error:', err),
  );

export const createGroup = (group: Omit<Group, 'id'>) =>
  addDoc(collection(db, COLLECTIONS.GROUPS), group);

export const updateGroup = (groupId: string, data: {name?: string; member_ids?: string[]}) =>
  updateDoc(doc(db, COLLECTIONS.GROUPS, groupId), data);

export const deleteGroup = (groupId: string) =>
  updateDoc(doc(db, COLLECTIONS.GROUPS, groupId), {is_active: false});

export const createGroupBuzz = async (
  senderId: string,
  memberIds: string[],
  reason: string,
  note: string | null,
) => {
  const now = Date.now();
  const promises = memberIds.map(memberId =>
    addDoc(collection(db, COLLECTIONS.BUZZES), {
      from_user_id: senderId,
      to_user_id: memberId,
      reason,
      note,
      created_at: now,
      responded_at: null,
      response: 'none',
      escalated: false,
    }),
  );
  return Promise.all(promises);
};

// ─── Call Logs ───────────────────────────────────────────
export const addCallLog = (log: Omit<CallLog, 'id'>) =>
  addDoc(collection(db, COLLECTIONS.CALL_LOGS), log);

export const getCallLogs = (userId: string, count = 20) =>
  getDocs(
    query(
      collection(db, COLLECTIONS.CALL_LOGS),
      where('caller_id', '==', userId),
      orderBy('started_at', 'desc'),
      firestoreLimit(count),
    ),
  ).then(snap => snap.docs.map(d => ({id: d.id, ...d.data()} as CallLog)));

// ─── Voice Mails ────────────────────────────────────────
export const addVoiceMail = (mail: Omit<VoiceMail, 'id'>) =>
  addDoc(collection(db, COLLECTIONS.VOICE_MAILS), mail);

export const subscribeToVoiceMails = (
  userId: string,
  callback: (mails: VoiceMail[]) => void,
) =>
  onSnapshot(
    query(
      collection(db, COLLECTIONS.VOICE_MAILS),
      where('to_user_id', '==', userId),
      orderBy('created_at', 'desc'),
    ),
    snap => {
      if (!snap) return;
      callback(snap.docs.map(d => ({id: d.id, ...d.data()} as VoiceMail)));
    },
    err => console.warn('subscribeToVoiceMails error:', err),
  );

export const markVoiceMailListened = (mailId: string) =>
  updateDoc(doc(db, COLLECTIONS.VOICE_MAILS, mailId), {listened: true});

export const deleteVoiceMail = (mailId: string) =>
  updateDoc(doc(db, COLLECTIONS.VOICE_MAILS, mailId), {deleted: true});

// ─── FCM ─────────────────────────────────────────────────
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
