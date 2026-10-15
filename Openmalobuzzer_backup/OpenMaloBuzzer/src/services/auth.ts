import AsyncStorage from '@react-native-async-storage/async-storage';
import {User} from '../types';
import {getUserByPhone, addUser, removeUser, updateFcmToken, updateUserProfile, resetUserPin} from './firebase';
import {hashPin, verifyPin} from './crypto';

const AUTH_KEY = '@openmalo_user';

/** Store user in AsyncStorage without sensitive fields. */
const storeUser = async (user: User) => {
  const {pin_hash: _, ...safeUser} = user;
  await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(safeUser));
};

export const login = async (phone: string, pin: string): Promise<User | null> => {
  const user = await getUserByPhone(phone);
  if (!user) throw new Error('No account found with this phone number');
  if (!verifyPin(pin, user.pin_hash)) throw new Error('Incorrect PIN');

  // Migrate legacy DJB2 hash to SHA-256
  if (!user.pin_hash.startsWith('v2:')) {
    const newHash = hashPin(pin);
    await resetUserPin(user.id, newHash);
  }

  await storeUser(user);

  // FCM token update — don't block login
  setTimeout(async () => {
    try {
      const {getMessaging, getToken} = require('@react-native-firebase/messaging');
      const messaging = getMessaging();
      const token = await getToken(messaging);
      if (token) await updateFcmToken(user.id, token);
    } catch {}
  }, 2000);

  return user;
};

export const signup = async (
  name: string,
  phone: string,
  pin: string,
  role: 'manager' | 'member' = 'member',
): Promise<User> => {
  const existing = await getUserByPhone(phone);
  if (existing) throw new Error('Phone number already registered');

  const userData: Omit<User, 'id'> = {
    name: name.trim(),
    phone,
    pin_hash: hashPin(pin),
    role,
    last_seen_at: Date.now(),
    is_active: true,
  };

  const docRef = await addUser(userData);
  const user: User = {id: docRef.id, ...userData};
  await storeUser(user);

  setTimeout(async () => {
    try {
      const {getMessaging, getToken} = require('@react-native-firebase/messaging');
      const messaging = getMessaging();
      const token = await getToken(messaging);
      if (token) await updateFcmToken(user.id, token);
    } catch {}
  }, 2000);

  return user;
};

export const deleteAccount = async (userId: string): Promise<void> => {
  await removeUser(userId);
  await AsyncStorage.removeItem(AUTH_KEY);
};

export const getStoredUser = async (): Promise<User | null> => {
  const data = await AsyncStorage.getItem(AUTH_KEY);
  if (!data) return null;
  const parsed = JSON.parse(data);
  // pin_hash is not stored locally; default to empty
  return {...parsed, pin_hash: parsed.pin_hash || ''};
};

export const logout = async () => {
  await AsyncStorage.removeItem(AUTH_KEY);
};

export const updateProfile = async (
  user: User,
  data: {name?: string; phone?: string},
): Promise<User> => {
  if (data.phone && data.phone !== user.phone) {
    const existing = await getUserByPhone(data.phone);
    if (existing) throw new Error('Phone number already in use');
  }
  await updateUserProfile(user.id, data);
  const updated = {...user, ...data};
  await storeUser(updated);
  return updated;
};

export const changePin = async (
  user: User,
  currentPin: string,
  newPin: string,
): Promise<void> => {
  // Fetch current pin_hash from Firestore (not stored locally)
  const freshUser = await getUserByPhone(user.phone);
  if (!freshUser) throw new Error('User not found');
  if (!verifyPin(currentPin, freshUser.pin_hash)) {
    throw new Error('Current PIN is incorrect');
  }
  const newHash = hashPin(newPin);
  await resetUserPin(user.id, newHash);
};
