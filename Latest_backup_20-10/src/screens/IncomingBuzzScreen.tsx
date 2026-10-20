import React, {useEffect} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, NativeModules} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BuzzPayload, BuzzResponse, Buzz} from '../types';
import {respondToBuzz, subscribeToBuzz} from '../services/firebase';
import {cancelBuzzNotification} from '../services/notification';

interface Props {
  payload: BuzzPayload;
  onDismiss: () => void;
}

const IncomingBuzzScreen: React.FC<Props> = ({payload, onDismiss}) => {
  const insets = useSafeAreaInsets();

  // Listen for cancellation by sender
  useEffect(() => {
    const unsub = subscribeToBuzz(payload.buzz_id, (buzz: Buzz) => {
      if (buzz.response === 'cancelled') {
        NativeModules.BuzzerService?.stopAlarm();
        cancelBuzzNotification(payload.buzz_id);
        onDismiss();
      }
    });
    return unsub;
  }, [payload.buzz_id, onDismiss]);

  useEffect(() => {
    // Native BuzzerService handles alarm sound + vibration in all states.
    // No JS alarm here to avoid double sound in foreground.
    return () => {
      NativeModules.BuzzerService?.stopAlarm();
    };
  }, []);

  const handleResponse = async (response: BuzzResponse) => {
    NativeModules.BuzzerService?.stopAlarm();
    await respondToBuzz(payload.buzz_id, response);
    await cancelBuzzNotification(payload.buzz_id);
    onDismiss();
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.avatarLarge}>
          <Text style={styles.avatarText}>
            {payload.from_user_name.charAt(0).toUpperCase()}
          </Text>
        </View>

        <Text style={styles.fromName}>{payload.from_user_name}</Text>
        <Text style={styles.reason}>{payload.reason}</Text>
        {payload.note && <Text style={styles.note}>{payload.note}</Text>}
      </View>

      <View style={[styles.buttons, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={[styles.responseBtn, styles.ackBtn]}
          onPress={() => handleResponse('ack')}
          activeOpacity={0.8}>
          <Text style={styles.responseBtnText}>Ack</Text>
          <Text style={styles.responseBtnSub}>Coming</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.responseBtn, styles.fiveMinBtn]}
          onPress={() => handleResponse('five_min')}
          activeOpacity={0.8}>
          <Text style={styles.responseBtnText}>5 min</Text>
          <Text style={styles.responseBtnSub}>Need a moment</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.responseBtn, styles.busyBtn]}
          onPress={() => handleResponse('busy')}
          activeOpacity={0.8}>
          <Text style={styles.responseBtnText}>Busy</Text>
          <Text style={styles.responseBtnSub}>Can't come now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0D0D0D',
    justifyContent: 'space-between',
    zIndex: 999,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  avatarLarge: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#FF4D4D',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  avatarText: {
    color: '#fff',
    fontSize: 44,
    fontWeight: '800',
  },
  fromName: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 12,
  },
  reason: {
    color: '#FF4D4D',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  note: {
    color: '#999',
    fontSize: 16,
    textAlign: 'center',
  },
  buttons: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 12,
  },
  responseBtn: {
    paddingVertical: 20,
    borderRadius: 16,
    alignItems: 'center',
  },
  ackBtn: {
    backgroundColor: '#4CAF50',
  },
  fiveMinBtn: {
    backgroundColor: '#FF9800',
  },
  busyBtn: {
    backgroundColor: '#F44336',
  },
  responseBtnText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
  },
  responseBtnSub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    marginTop: 2,
  },
});

export default IncomingBuzzScreen;
