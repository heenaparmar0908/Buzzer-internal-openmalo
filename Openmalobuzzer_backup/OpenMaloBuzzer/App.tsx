import React, {useState, useEffect, useCallback, useRef} from 'react';
import {StatusBar, ActivityIndicator, View, StyleSheet, AppState, NativeModules, Platform, PermissionsAndroid} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {useAuth} from './src/hooks/useAuth';
import {createNotificationChannel, setupNotificationListeners, showBuzzNotification, cancelBuzzNotification} from './src/services/notification';
import {respondToBuzz, subscribeToIncomingBuzzes, subscribeToUsers, requestFcmPermission} from './src/services/firebase';
import {promptBatteryOptimization} from './src/services/batteryOptimization';
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

type Screen = 'home' | 'buzz' | 'incoming' | 'settings' | 'profile' | 'history' | 'groups' | 'group-buzz' | 'voice-call' | 'voice-mail';

function App() {
  const {user, loading, login, signUp, deleteAccount, updateProfile, changePin, logout} = useAuth();
  const [screen, setScreen] = useState<Screen>('home');
  const [authScreen, setAuthScreen] = useState<'login' | 'signup'>('login');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [incomingPayload, setIncomingPayload] = useState<BuzzPayload | null>(null);
  const usersMapRef = useRef<Record<string, string>>({});

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
    promptBatteryOptimization();
  }, []);

  useEffect(() => {
    if (user) {
      BuzzerService?.startService(user.id);
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') BuzzerService?.startService(user.id);
      });
      return () => sub.remove();
    } else {
      BuzzerService?.stopService();
    }
  }, [user]);

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
        const payload: BuzzPayload = {
          buzz_id: buzz.id,
          from_user_id: buzz.from_user_id,
          from_user_name: usersMapRef.current[buzz.from_user_id] || 'Someone',
          reason: buzz.reason,
          note: buzz.note,
        };
        if (AppState.currentState === 'active') {
          setIncomingPayload(payload);
          setScreen('incoming');
        } else {
          showBuzzNotification(payload).catch(() => {});
        }
      },
      (buzzId) => {
        cancelBuzzNotification(buzzId).catch(() => {});
        setIncomingPayload(prev => {
          if (prev?.buzz_id === buzzId) return null;
          return prev;
        });
        setScreen(prev => {
          if (prev === 'incoming') return 'home';
          return prev;
        });
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
        if (data.type === 'buzz_cancelled') {
          cancelBuzzNotification(data.buzz_id).catch(() => {});
          setIncomingPayload(prev => {
            if (prev?.buzz_id === data.buzz_id) return null;
            return prev;
          });
          setScreen(prev => {
            if (prev === 'incoming') return 'home';
            return prev;
          });
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
      payload => { setIncomingPayload(payload); setScreen('incoming'); },
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) return;
    const checkPendingBuzz = () => {
      BuzzerService?.getPendingBuzz?.()
        .then((data: any) => {
          if (data?.buzz_id) {
            setIncomingPayload({
              buzz_id: data.buzz_id,
              from_user_id: data.from_user_id,
              from_user_name: data.from_user_name || 'Someone',
              reason: data.reason,
              note: data.note || null,
            });
            setScreen('incoming');
          }
        })
        .catch(() => {});
    };
    checkPendingBuzz();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkPendingBuzz();
    });
    return () => sub.remove();
  }, [user]);

  const handleLogout = useCallback(async () => {
    BuzzerService?.stopService();
    setScreen('home');
    setSelectedUser(null);
    setSelectedGroup(null);
    setIncomingPayload(null);
    setAuthScreen('login');
    await logout();
  }, [logout]);

  const handleDeleteAccount = useCallback(async () => {
    BuzzerService?.stopService();
    setScreen('home');
    setSelectedUser(null);
    setSelectedGroup(null);
    setIncomingPayload(null);
    setAuthScreen('login');
    await deleteAccount();
  }, [deleteAccount]);

  const handleSelectUser = useCallback((u: User) => { setSelectedUser(u); setScreen('buzz'); }, []);
  const handleCloseBuzz = useCallback(() => { setSelectedUser(null); setScreen('home'); }, []);
  const handleDismissIncoming = useCallback(() => { setIncomingPayload(null); setScreen('home'); }, []);
  const handleCallUser = useCallback((u: User) => { setSelectedUser(u); setScreen('voice-call'); }, []);
  const handleVoiceMail = useCallback((u?: User) => { setSelectedUser(u || null); setScreen('voice-mail'); }, []);
  const handleBuzzGroup = useCallback((g: Group) => { setSelectedGroup(g); setScreen('group-buzz'); }, []);
  const handleCloseGroup = useCallback(() => { setSelectedGroup(null); setScreen('home'); }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
      {loading ? (
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
          {screen === 'incoming' && incomingPayload && <IncomingBuzzScreen payload={incomingPayload} onDismiss={handleDismissIncoming} />}
          {screen === 'home' && (
            <HomeScreen
              currentUser={user}
              onSelectUser={handleSelectUser}
              onCallUser={handleCallUser}
              onVoiceMail={handleVoiceMail}
              onSettings={() => setScreen('settings')}
              onProfile={() => setScreen('profile')}
              onHistory={() => setScreen('history')}
              onGroups={() => setScreen('groups')}
              onBuzzGroup={handleBuzzGroup}
            />
          )}
          {screen === 'buzz' && selectedUser && <BuzzSheet sender={user} receiver={selectedUser} onClose={handleCloseBuzz} />}
          {screen === 'groups' && <GroupsScreen currentUser={user} onBack={() => setScreen('home')} onBuzzGroup={handleBuzzGroup} />}
          {screen === 'group-buzz' && selectedGroup && <GroupBuzzSheet sender={user} group={selectedGroup} onClose={handleCloseGroup} />}
          {screen === 'voice-call' && selectedUser && <VoiceCallScreen caller={user} receiver={selectedUser} onClose={() => { setSelectedUser(null); setScreen('home'); }} />}
          {screen === 'voice-mail' && <VoiceMailScreen currentUser={user} targetUser={selectedUser || undefined} onBack={() => { setSelectedUser(null); setScreen('home'); }} />}
          {screen === 'settings' && <SettingsScreen currentUser={user} onBack={() => setScreen('home')} />}
          {screen === 'profile' && <ProfileScreen currentUser={user} onBack={() => setScreen('home')} onLogout={handleLogout} onDeleteAccount={handleDeleteAccount} onUpdateProfile={updateProfile} onChangePin={changePin} />}
          {screen === 'history' && <HistoryScreen onBack={() => setScreen('home')} />}
        </>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {flex: 1, backgroundColor: '#0D0D0D', alignItems: 'center', justifyContent: 'center'},
});

export default App;
