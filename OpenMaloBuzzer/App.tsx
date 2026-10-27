import React, {useState, useEffect, useCallback, useRef} from 'react';
import {StatusBar, ActivityIndicator, View, StyleSheet, AppState, NativeModules, Platform, PermissionsAndroid, DeviceEventEmitter} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {useAuth} from './src/hooks/useAuth';
import {createNotificationChannel, setupNotificationListeners, cancelBuzzNotification} from './src/services/notification';
import {respondToBuzz, subscribeToIncomingBuzzes, subscribeToUsers, requestFcmPermission, getUserName} from './src/services/firebase';
import {promptBatteryOptimization, promptDndAccess} from './src/services/batteryOptimization';
import {BuzzPayload, User, Group} from './src/types';

import LoginScreen from './src/screens/LoginScreen';
import SignupScreen from './src/screens/SignupScreen';
import HomeScreen from './src/screens/HomeScreen';
import BuzzSheet from './src/screens/BuzzSheet';
import IncomingBuzzScreen from './src/screens/IncomingBuzzScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import GroupsScreen from './src/screens/GroupsScreen';
import GroupBuzzSheet from './src/screens/GroupBuzzSheet';
import VoiceCallScreen from './src/screens/VoiceCallScreen';
import VoiceMailScreen from './src/screens/VoiceMailScreen';

const {BuzzerService} = NativeModules;

type Screen = 'home' | 'buzz' | 'settings' | 'profile' | 'history' | 'groups' | 'group-buzz' | 'voice-call' | 'voice-mail';

function App() {
  const {user, loading, login, signUp, deleteAccount, updateProfile, changePin, logout} = useAuth();
  const [screen, setScreen] = useState<Screen>('home');
  const [authScreen, setAuthScreen] = useState<'login' | 'signup'>('login');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [incomingPayload, setIncomingPayload] = useState<BuzzPayload | null>(null);
  const [initialReason, setInitialReason] = useState<string | undefined>(undefined);
  const [autoSend, setAutoSend] = useState(false);
  const [pendingChecked, setPendingChecked] = useState(false);
  const [homeTab, setHomeTab] = useState<'recent' | 'people' | 'groups' | 'voice'>('recent');
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const usersMapRef = useRef<Record<string, string>>({});
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    const requestPermissions = async () => {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }
      await requestFcmPermission();
      await createNotificationChannel();
    };
    requestPermissions().catch(() => {});
  }, []);

  useEffect(() => {
    if (user) {
      BuzzerService?.startService(user.id);
      promptBatteryOptimization();
      setTimeout(() => promptDndAccess(), 2000);
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          // Use health check: only restarts the service if OEM killed it
          BuzzerService?.checkAndRecoverService?.().catch(() => {
            // Fallback if health check not available
            BuzzerService?.startService(user.id);
          });
        }
      });
      return () => sub.remove();
    }
    // Only stop service after loading is complete and user is definitely null (logged out)
    // Don't stop during initial load — native service may already be running
    if (!loading && !user) {
      BuzzerService?.stopService();
    }
  }, [user, loading]);

  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToUsers(users => {
      const map: Record<string, string> = {};
      users.forEach(u => { map[u.id] = u.name; });
      usersMapRef.current = map;
    });
    return unsub;
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribeToIncomingBuzzes(
      user.id,
      (buzz) => {
        console.log(`[T6-RT] Supabase Realtime received buzz ${buzz.id} at ${Date.now()}`);
        if (AppState.currentState === 'active') {
          const name = buzz.from_user_name || usersMapRef.current[buzz.from_user_id] || 'User';
          setIncomingPayload({
            buzz_id: buzz.id,
            from_user_id: buzz.from_user_id,
            from_user_name: name,
            reason: buzz.reason,
            note: buzz.note,
          });
        }
        // Background/killed notifications are handled by FCM setBackgroundMessageHandler
      },
      (buzzId) => {
        // Only cancel the notification here. Don't clear incomingPayload —
        // IncomingBuzzScreen's own subscribeToBuzz listener handles dismissal.
        // Clearing here can race with the FCM onMessage handler that sets
        // the payload, causing "sound plays but no screen" when both fire
        // in the same React batch.
        cancelBuzzNotification(buzzId).catch(() => {});
      },
    );
    return unsubscribe;
  }, [user]);

  useEffect(() => {
    try {
      const {getMessaging, onMessage} = require('@react-native-firebase/messaging');
      const messaging = getMessaging();
      const unsub = onMessage(messaging, (remoteMessage: any) => {
        const data = remoteMessage.data;
        if (!data) return;
        // Don't process buzzes before auth is complete — checkPending
        // will pick them up once the user is loaded.
        if (!userRef.current) return;
        if (data.type === 'buzz') {
          console.log(`[T6] FCM onMessage received buzz ${data.buzz_id} at ${Date.now()}`);
          // Show IncomingBuzzScreen immediately from FCM data — don't wait
          // for Supabase Realtime which may have variable latency.
          setIncomingPayload({
            buzz_id: data.buzz_id,
            from_user_id: data.from_user_id || '',
            from_user_name: data.from_user_name || 'User',
            reason: data.reason || '',
            note: data.note && data.note !== 'null' ? data.note : null,
          });
          if (Platform.OS === 'android') {
            // Also start native alarm (max volume, vibration, DND override)
            BuzzerService?.showBuzz?.(
              data.buzz_id,
              data.from_user_id || '',
              data.from_user_name || 'User',
              data.reason || '',
              data.note || null,
            ).catch(() => {});
          }
        }
        if (data.type === 'buzz_cancelled') {
          // Only stop the alarm if the cancelled buzz is the one currently
          // active. Without this check, cancelling an old already-answered
          // buzz would kill a newer buzz's alarm.
          setIncomingPayload(prev => {
            if (prev?.buzz_id === data.buzz_id) {
              BuzzerService?.stopAlarm?.();
              return null;
            }
            return prev;
          });
          cancelBuzzNotification(data.buzz_id).catch(() => {});
        }
      });
      return unsub;
    } catch (err) {
      console.warn('FCM foreground handler setup error:', err);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = setupNotificationListeners(
      (buzzId, response) => { respondToBuzz(buzzId, response as any).catch(() => {}); },
      payload => { setIncomingPayload(payload); },
      () => { setSelectedUser(null); setScreen('voice-mail'); },
    );
    return unsubscribe;
  }, []);

  // Listen for native navigation events (foreground notification tap)
  useEffect(() => {
    if (!user) return;
    const sub = DeviceEventEmitter.addListener('onNavigate', (event: any) => {
      if (event?.screen === 'voice_mail') {
        setSelectedUser(null);
        setScreen('voice-mail');
      }
    });
    return () => sub.remove();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const checkPending = async () => {
      try {
        const nav = await BuzzerService?.getPendingNavigation?.();
        if (nav === 'voice_mail') {
          setSelectedUser(null);
          setScreen('voice-mail');
          setPendingChecked(true);
          return;
        }
        const data = await BuzzerService?.getPendingBuzz?.();
        if (data?.buzz_id) {
          const immediateName = data.from_user_name && data.from_user_name !== 'Someone'
            ? data.from_user_name : 'User';
          setIncomingPayload({
            buzz_id: data.buzz_id,
            from_user_id: data.from_user_id,
            from_user_name: immediateName,
            reason: data.reason,
            note: data.note || null,
          });
          setPendingChecked(true);
          // Resolve real name in background
          if (!data.from_user_name || data.from_user_name === 'Someone') {
            getUserName(data.from_user_id).then(resolvedName => {
              setIncomingPayload(prev => {
                if (prev && prev.buzz_id === data.buzz_id) {
                  return {...prev, from_user_name: resolvedName};
                }
                return prev;
              });
            }).catch(() => {});
          }
          return;
        }

        // iOS: check if app was opened from a notifee notification (killed state)
        try {
          const notifee = require('@notifee/react-native').default;
          const initial = await notifee.getInitialNotification();
          if (initial?.notification?.data) {
            const nData = initial.notification.data;
            if (nData.type === 'voice_message') {
              setSelectedUser(null);
              setScreen('voice-mail');
              setPendingChecked(true);
              return;
            }
            if (nData.buzz_id) {
              setIncomingPayload({
                buzz_id: nData.buzz_id as string,
                from_user_id: (nData.from_user_id as string) || '',
                from_user_name: (nData.from_user_name as string) || 'User',
                reason: (nData.reason as string) || '',
                note: nData.note as string || null,
              });
              setPendingChecked(true);
              return;
            }
          }
        } catch {}
      } catch (err: any) {
        console.warn('checkPending failed:', err?.message || err);
      }
      setPendingChecked(true);
    };
    checkPending();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkPending();
    });
    return () => sub.remove();
  }, [user]);

  const handleLogout = useCallback(async () => {
    BuzzerService?.stopService();
    setScreen('home');
    setSelectedUser(null);
    setSelectedGroup(null);
    setIncomingPayload(null);
    setPendingChecked(false);
    setAuthScreen('login');
    await logout();
  }, [logout]);

  const handleDeleteAccount = useCallback(async () => {
    BuzzerService?.stopService();
    setScreen('home');
    setSelectedUser(null);
    setSelectedGroup(null);
    setIncomingPayload(null);
    setPendingChecked(false);
    setAuthScreen('login');
    await deleteAccount();
  }, [deleteAccount]);

  const handleSelectUser = useCallback((u: User) => { setAutoSend(false); setInitialReason(undefined); setSelectedUser(u); setScreen('buzz'); }, []);
  const handleBuzzAgain = useCallback((u: User, reason: string) => { setAutoSend(true); setInitialReason(reason); setSelectedUser(u); setScreen('buzz'); }, []);
  const handleEditBuzz = useCallback((u: User, reason: string) => { setAutoSend(false); setInitialReason(reason); setSelectedUser(u); setScreen('buzz'); }, []);
  const handleCloseBuzz = useCallback(() => { setSelectedUser(null); setInitialReason(undefined); setAutoSend(false); setScreen('home'); }, []);
  const handleDismissIncoming = useCallback(() => { setIncomingPayload(null); }, []);
  const handleCallUser = useCallback((u: User) => { setSelectedUser(u); setScreen('voice-call'); }, []);
  const handleVoiceMail = useCallback((u?: User) => { setSelectedUser(u || null); setScreen('voice-mail'); }, []);
  const handleBuzzGroup = useCallback((g: Group) => { setSelectedGroup(g); setScreen('group-buzz'); }, []);
  const handleEditGroup = useCallback((g: Group) => { setEditGroup(g); setScreen('groups'); }, []);
  const handleCloseGroup = useCallback(() => { setSelectedGroup(null); setHomeTab('groups'); setScreen('home'); }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
      {loading || (user && !pendingChecked) ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#FF4D4D" />
        </View>
      ) : !user ? (
        authScreen === 'login' ? (
          <LoginScreen onLogin={login} onGoToSignup={() => setAuthScreen('signup')} />
        ) : (
          <SignupScreen onSignup={signUp} onGoToLogin={() => setAuthScreen('login')} />
        )
      ) : (
        <>
          {screen === 'home' && (
            <HomeScreen
              currentUser={user}
              onSelectUser={handleSelectUser}
              onBuzzAgain={handleBuzzAgain}
              onEditBuzz={handleEditBuzz}
              onCallUser={handleCallUser}
              onVoiceMail={handleVoiceMail}
              onSettings={() => setScreen('settings')}
              onProfile={() => setScreen('profile')}
              onHistory={() => setScreen('history')}
              onGroups={() => setScreen('groups')}
              onBuzzGroup={handleBuzzGroup}
              onEditGroup={handleEditGroup}
              initialTab={homeTab}
            />
          )}
          {screen === 'buzz' && selectedUser && <BuzzSheet key={selectedUser.id + (initialReason || '') + (autoSend ? '_auto' : '')} sender={user} receiver={selectedUser} onClose={handleCloseBuzz} initialReason={initialReason} autoSend={autoSend} />}
          {screen === 'groups' && <GroupsScreen currentUser={user} onBack={() => { setEditGroup(null); setHomeTab('groups'); setScreen('home'); }} onBuzzGroup={handleBuzzGroup} initialEditGroup={editGroup || undefined} />}
          {screen === 'group-buzz' && selectedGroup && <GroupBuzzSheet sender={user} group={selectedGroup} onClose={handleCloseGroup} />}
          {screen === 'voice-call' && selectedUser && <VoiceCallScreen caller={user} receiver={selectedUser} onClose={() => { setSelectedUser(null); setScreen('home'); }} />}
          {screen === 'voice-mail' && <VoiceMailScreen currentUser={user} targetUser={selectedUser || undefined} onBack={() => { setSelectedUser(null); setScreen('home'); }} />}
          {screen === 'settings' && <SettingsScreen currentUser={user} onBack={() => setScreen('home')} />}
          {screen === 'profile' && <ProfileScreen currentUser={user} onBack={() => setScreen('home')} onLogout={handleLogout} onDeleteAccount={handleDeleteAccount} onUpdateProfile={updateProfile} onChangePin={changePin} />}
          {screen === 'history' && <HistoryScreen currentUser={user} onBack={() => setScreen('home')} />}

          {/* Incoming buzz overlay — renders on TOP of any screen without unmounting it */}
          {incomingPayload && <IncomingBuzzScreen payload={incomingPayload} onDismiss={handleDismissIncoming} />}
        </>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {flex: 1, backgroundColor: '#0D0D0D', alignItems: 'center', justifyContent: 'center'},
});

export default App;
