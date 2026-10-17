import {useState, useEffect, useCallback} from 'react';
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
import {updateLastSeen} from '../services/firebase';

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

  useEffect(() => {
    if (!user) return;
    updateLastSeen(user.id).catch(() => {});
    const interval = setInterval(() => updateLastSeen(user.id).catch(() => {}), 60000);
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
