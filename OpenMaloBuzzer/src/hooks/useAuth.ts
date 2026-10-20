import {useState, useEffect, useCallback} from 'react';
import {AppState} from 'react-native';
import {User} from '../types';
import {
  login as authLogin,
  signup as authSignup,
  deleteAccount as authDeleteAccount,
  updateProfile as authUpdateProfile,
  changePin as authChangePin,
  getStoredUser,
  logout as authLogout,
} from '../services/auth';
import {updateLastSeen, updateFcmToken, getFcmToken} from '../services/firebase';

/** Fetch current FCM token and write it to Firestore. */
const refreshFcmToken = async (userId: string) => {
  try {
    const token = await getFcmToken();
    if (token) await updateFcmToken(userId, token);
  } catch {}
};

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStoredUser()
      .then(u => {
        setUser(u);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  // Refresh FCM token on every app open and when app returns to foreground
  useEffect(() => {
    if (!user) return;
    refreshFcmToken(user.id);
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') refreshFcmToken(user.id);
    });
    return () => sub.remove();
  }, [user]);

  // Listen for FCM token rotation and update Firestore immediately
  useEffect(() => {
    if (!user) return;
    try {
      const {getMessaging, onTokenRefresh} = require('@react-native-firebase/messaging');
      const messaging = getMessaging();
      const unsub = onTokenRefresh(messaging, async (newToken: string) => {
        if (newToken) await updateFcmToken(user.id, newToken).catch(() => {});
      });
      return unsub;
    } catch {}
  }, [user]);

  useEffect(() => {
    if (!user) return;
    updateLastSeen(user.id).catch(() => {});
    const interval = setInterval(() => updateLastSeen(user.id).catch(() => {}), 15000);
    return () => clearInterval(interval);
  }, [user]);

  const login = useCallback(async (phone: string, pin: string) => {
    const u = await authLogin(phone, pin);
    if (u) setUser(u);
    return u;
  }, []);

  const signUp = useCallback(async (name: string, phone: string, pin: string, role: 'manager' | 'member' = 'member') => {
    const u = await authSignup(name, phone, pin, role);
    setUser(u);
    return u;
  }, []);

  const deleteAccount = useCallback(async () => {
    if (!user) return;
    await authDeleteAccount(user.id);
    setUser(null);
  }, [user]);

  const updateProfile = useCallback(async (data: {name?: string; phone?: string}) => {
    if (!user) return;
    const updated = await authUpdateProfile(user, data);
    setUser(updated);
  }, [user]);

  const changePin = useCallback(async (currentPin: string, newPin: string) => {
    if (!user) return;
    await authChangePin(user, currentPin, newPin);
  }, [user]);

  const logout = useCallback(async () => {
    await authLogout();
    setUser(null);
  }, []);

  return {user, loading, login, signUp, deleteAccount, updateProfile, changePin, logout};
};
