import React, {useState, useEffect, useRef} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Linking, AppState} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {User} from '../types';
import {addCallLog} from '../services/firebase';

interface Props {
  caller: User;
  receiver: User;
  onClose: () => void;
}

const VoiceCallScreen: React.FC<Props> = ({caller, receiver, onClose}) => {
  const insets = useSafeAreaInsets();
  const [callState, setCallState] = useState<'dialing' | 'active' | 'ended'>('dialing');
  const [seconds, setSeconds] = useState(0);
  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didDialRef = useRef(false);

  useEffect(() => {
    // Initiate phone call
    if (!didDialRef.current) {
      didDialRef.current = true;
      Linking.openURL(`tel:${receiver.phone}`).catch(() => {});
    }

    // Track when app returns from phone call
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && didDialRef.current && callState !== 'ended') {
        setCallState('ended');
      }
    });

    // Start timer
    timerRef.current = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    return () => {
      sub.remove();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (callState === 'ended') {
      if (timerRef.current) clearInterval(timerRef.current);
      // Log the call
      addCallLog({
        caller_id: caller.id,
        receiver_id: receiver.id,
        started_at: startTimeRef.current,
        duration_seconds: seconds,
      }).catch(() => {});
    }
  }, [callState]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleEndCall = () => {
    setCallState('ended');
  };

  return (
    <View style={[styles.container, {paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20}]}>
      <View style={styles.content}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{receiver.name.charAt(0).toUpperCase()}</Text>
        </View>
        <Text style={styles.name}>{receiver.name}</Text>
        <Text style={styles.status}>
          {callState === 'dialing' ? 'Calling...' : callState === 'active' ? 'In Call' : 'Call Ended'}
        </Text>
        <Text style={styles.timer}>{formatTime(seconds)}</Text>
      </View>

      <View style={styles.actions}>
        {callState === 'ended' ? (
          <>
            <TouchableOpacity style={styles.callAgainBtn} onPress={() => {
              didDialRef.current = false;
              startTimeRef.current = Date.now();
              setSeconds(0);
              setCallState('dialing');
              Linking.openURL(`tel:${receiver.phone}`).catch(() => {});
              didDialRef.current = true;
              timerRef.current = setInterval(() => {
                setSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
              }, 1000);
            }}>
              <Text style={styles.callAgainText}>Call Again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>Close</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity style={styles.endCallBtn} onPress={handleEndCall}>
            <Text style={styles.endCallText}>End Call</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0D0D0D', justifyContent: 'space-between'},
  content: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  avatar: {width: 120, height: 120, borderRadius: 60, backgroundColor: '#4CAF50', alignItems: 'center', justifyContent: 'center', marginBottom: 24},
  avatarText: {color: '#fff', fontSize: 52, fontWeight: '800'},
  name: {color: '#fff', fontSize: 28, fontWeight: '800', marginBottom: 8},
  status: {color: '#888', fontSize: 16, marginBottom: 4},
  timer: {color: '#666', fontSize: 32, fontWeight: '300', marginTop: 8},
  actions: {paddingHorizontal: 20, gap: 12},
  endCallBtn: {backgroundColor: '#F44336', paddingVertical: 20, borderRadius: 16, alignItems: 'center'},
  endCallText: {color: '#fff', fontSize: 20, fontWeight: '800'},
  callAgainBtn: {backgroundColor: '#4CAF50', paddingVertical: 18, borderRadius: 16, alignItems: 'center'},
  callAgainText: {color: '#fff', fontSize: 18, fontWeight: '700'},
  closeBtn: {backgroundColor: '#1A1A1A', paddingVertical: 16, borderRadius: 16, alignItems: 'center'},
  closeBtnText: {color: '#ccc', fontSize: 16, fontWeight: '600'},
});

export default VoiceCallScreen;
