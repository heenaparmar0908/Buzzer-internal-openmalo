import React, {useState, useEffect, useRef} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Vibration,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Sound from 'react-native-sound';
import {User, Buzz, BuzzResponse} from '../types';
import {useReasons} from '../hooks/useReasons';
import {createBuzz, subscribeToBuzz, markEscalated, respondToBuzz} from '../services/firebase';
import {
  MAX_NOTE_LENGTH,
  REBUZZ_TIMEOUT_MS,
  NO_RESPONSE_TIMEOUT_MS,
} from '../constants';

interface Props {
  sender: User;
  receiver: User;
  onClose: () => void;
}

type BuzzState = 'select' | 'sent' | 'responded' | 'no_response';

const RESPONSE_LABELS: Record<BuzzResponse, string> = {
  ack: 'Acknowledged — coming',
  five_min: 'Will be there in 5 min',
  busy: 'Busy right now',
  cancelled: 'Buzz cancelled',
  dismissed: 'Buzz dismissed',
  none: 'No response',
};

const BuzzSheet: React.FC<Props> = ({sender, receiver, onClose}) => {
  const insets = useSafeAreaInsets();
  const reasons = useReasons();
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [isOther, setIsOther] = useState(false);
  const [customReason, setCustomReason] = useState('');
  const [note, setNote] = useState('');
  const [buzzState, setBuzzState] = useState<BuzzState>('select');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [response, setResponse] = useState<BuzzResponse | null>(null);

  const buzzIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const rebuzzSentRef = useRef(false);
  const sentSoundRef = useRef<Sound | null>(null);

  const sendBuzz = async () => {
    const reason = isOther ? customReason.trim() : selectedReason;
    if (!reason) return;

    const buzzData: Omit<Buzz, 'id'> = {
      from_user_id: sender.id,
      to_user_id: receiver.id,
      reason,
      note: note.trim() || null,
      created_at: Date.now(),
      responded_at: null,
      response: 'none',
      escalated: false,
    };

    const doc = await createBuzz(buzzData);
    buzzIdRef.current = doc.id;
    setBuzzState('sent');

    // Play sent confirmation sound
    const sentSound = new Sound('buzz_alarm.wav', Sound.MAIN_BUNDLE, (err) => {
      if (!err) {
        sentSound.setVolume(0.5);
        sentSound.play(() => {
          sentSound.release();
          if (sentSoundRef.current === sentSound) sentSoundRef.current = null;
        });
      }
    });
    sentSoundRef.current = sentSound;
    Vibration.vibrate(200);

    const start = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 1000);

    unsubRef.current = subscribeToBuzz(doc.id, (buzz: Buzz) => {
      if (buzz.response !== 'none') {
        setResponse(buzz.response);
        setBuzzState('responded');
        if (timerRef.current) clearInterval(timerRef.current);
        setTimeout(() => onClose(), 3000);
      }
    });
  };

  const handleCancelBuzz = async () => {
    if (buzzIdRef.current) {
      await respondToBuzz(buzzIdRef.current, 'cancelled');
    }
    if (timerRef.current) clearInterval(timerRef.current);
    if (unsubRef.current) unsubRef.current();
    onClose();
  };

  useEffect(() => {
    if (buzzState !== 'sent') return;

    if (elapsedMs >= NO_RESPONSE_TIMEOUT_MS) {
      setBuzzState('no_response');
      if (timerRef.current) clearInterval(timerRef.current);
    } else if (elapsedMs >= REBUZZ_TIMEOUT_MS && !rebuzzSentRef.current) {
      rebuzzSentRef.current = true;
      if (buzzIdRef.current) {
        markEscalated(buzzIdRef.current);
      }
      Vibration.vibrate([0, 300, 100, 300]);
    }
  }, [elapsedMs, buzzState]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (unsubRef.current) unsubRef.current();
      if (sentSoundRef.current) {
        sentSoundRef.current.stop();
        sentSoundRef.current.release();
      }
    };
  }, []);

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const handleCall = () => {
    Linking.openURL(`tel:${receiver.phone}`);
  };

  if (buzzState === 'select') {
    return (
      <View style={[styles.container, {paddingBottom: insets.bottom}]}>
        <View style={[styles.header, {paddingTop: insets.top + 12}]}>
          <TouchableOpacity onPress={onClose}><Icon name="close" size={24} color="#888" /></TouchableOpacity>
          <Text style={styles.headerTitle}>Buzz {receiver.name}</Text>
          <View style={{width: 32}} />
        </View>
        <Text style={styles.label}>Select reason</Text>
        <View style={styles.chipsContainer}>
          {reasons.map(r => (
            <TouchableOpacity key={r.id} style={[styles.chip, !isOther && selectedReason === r.label && styles.chipSelected]} onPress={() => { setSelectedReason(r.label); setIsOther(false); }}>
              <Text style={[styles.chipText, !isOther && selectedReason === r.label && styles.chipTextSelected]}>{r.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.chip, isOther && styles.chipSelected]} onPress={() => { setIsOther(true); setSelectedReason(null); }}>
            <Text style={[styles.chipText, isOther && styles.chipTextSelected]}>Other</Text>
          </TouchableOpacity>
        </View>
        {isOther && (
          <TextInput
            style={styles.noteInput}
            placeholder="Enter custom reason"
            placeholderTextColor="#666"
            value={customReason}
            onChangeText={setCustomReason}
            maxLength={50}
            autoFocus
          />
        )}
        <TextInput style={styles.noteInput} placeholder="Optional note (40 chars)" placeholderTextColor="#666" value={note} onChangeText={setNote} maxLength={MAX_NOTE_LENGTH} />
        <TouchableOpacity
          style={[styles.buzzButton, !(isOther ? customReason.trim() : selectedReason) && styles.buzzButtonDisabled]}
          onPress={sendBuzz}
          disabled={!(isOther ? customReason.trim() : selectedReason)}
          activeOpacity={0.8}>
          <Text style={styles.buzzButtonText}>BUZZ</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (buzzState === 'sent') {
    return (
      <View style={[styles.container, {paddingBottom: insets.bottom}]}>
        <View style={[styles.header, {paddingTop: insets.top + 12}]}>
          <TouchableOpacity onPress={handleCancelBuzz}><Icon name="close" size={24} color="#888" /></TouchableOpacity>
          <Text style={styles.headerTitle}>Buzzing {receiver.name}</Text>
          <View style={{width: 32}} />
        </View>
        <View style={styles.statusContainer}>
          <View style={styles.pulseOuter}><View style={styles.pulseInner}><Icon name="notifications-active" size={28} color="#fff" /></View></View>
          <Text style={styles.waitingText}>Waiting for response...</Text>
          <Text style={styles.elapsedText}>{formatTime(elapsedMs)}</Text>
          {rebuzzSentRef.current && <Text style={styles.rebuzzText}>Re-buzz sent (escalated)</Text>}
        </View>
      </View>
    );
  }

  if (buzzState === 'responded' && response) {
    return (
      <View style={[styles.container, {paddingBottom: insets.bottom}]}>
        <View style={[styles.header, {paddingTop: insets.top + 12}]}><View style={{width: 32}} /><Text style={styles.headerTitle}>{receiver.name}</Text><View style={{width: 32}} /></View>
        <View style={styles.statusContainer}>
          <Text style={[styles.responseIcon, {color: response === 'ack' ? '#4CAF50' : response === 'five_min' ? '#FF9800' : response === 'dismissed' ? '#9C27B0' : '#F44336'}]}>
            <Icon name={response === 'ack' ? 'check-circle' : response === 'five_min' ? 'timer' : response === 'dismissed' ? 'visibility' : 'cancel'} size={48} color={response === 'ack' ? '#4CAF50' : response === 'five_min' ? '#FF9800' : response === 'dismissed' ? '#9C27B0' : '#F44336'} />
          </Text>
          <Text style={styles.responseText}>{RESPONSE_LABELS[response]}</Text>
          <Text style={styles.elapsedText}>{formatTime(elapsedMs)}</Text>
        </View>
        <TouchableOpacity style={styles.doneButton} onPress={onClose}><Text style={styles.doneButtonText}>Done</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, {paddingBottom: insets.bottom}]}>
      <View style={[styles.header, {paddingTop: insets.top + 12}]}><View style={{width: 32}} /><Text style={styles.headerTitle}>{receiver.name}</Text><View style={{width: 32}} /></View>
      <View style={styles.statusContainer}>
        <Text style={styles.noResponseIcon}>!</Text>
        <Text style={styles.noResponseText}>No response</Text>
        <Text style={styles.elapsedText}>{formatTime(elapsedMs)}</Text>
      </View>
      <TouchableOpacity style={styles.callButton} onPress={handleCall}><Icon name="call" size={20} color="#fff" /><Text style={styles.callButtonText}>  Call {receiver.name}</Text></TouchableOpacity>
      <TouchableOpacity style={styles.doneButton} onPress={onClose}><Text style={styles.doneButtonText}>Close</Text></TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0D0D0D', paddingHorizontal: 20},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 16},
  closeBtn: {color: '#888', fontSize: 24, padding: 4},
  headerTitle: {color: '#fff', fontSize: 20, fontWeight: '700'},
  label: {color: '#888', fontSize: 14, fontWeight: '600', marginBottom: 12, marginTop: 8},
  chipsContainer: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {backgroundColor: '#1A1A1A', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: '#333'},
  chipSelected: {backgroundColor: '#3a1515', borderColor: '#FF4D4D'},
  chipText: {color: '#ccc', fontSize: 15},
  chipTextSelected: {color: '#FF4D4D', fontWeight: '600'},
  noteInput: {backgroundColor: '#1A1A1A', color: '#fff', fontSize: 16, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 10, marginTop: 16, borderWidth: 1, borderColor: '#333'},
  buzzButton: {backgroundColor: '#FF4D4D', paddingVertical: 20, borderRadius: 14, alignItems: 'center', marginTop: 24},
  buzzButtonDisabled: {opacity: 0.4},
  buzzButtonText: {color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 2},
  statusContainer: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  pulseOuter: {width: 100, height: 100, borderRadius: 50, backgroundColor: '#3a1515', alignItems: 'center', justifyContent: 'center', marginBottom: 24},
  pulseInner: {width: 60, height: 60, borderRadius: 30, backgroundColor: '#FF4D4D', alignItems: 'center', justifyContent: 'center'},
  pulseEmoji: {fontSize: 28},
  waitingText: {color: '#ccc', fontSize: 18, marginBottom: 8},
  elapsedText: {color: '#666', fontSize: 16},
  rebuzzText: {color: '#FF9800', fontSize: 14, marginTop: 12},
  responseIcon: {fontSize: 48, marginBottom: 16},
  responseText: {color: '#fff', fontSize: 20, fontWeight: '600', marginBottom: 8, textAlign: 'center'},
  noResponseIcon: {fontSize: 48, color: '#FF9800', fontWeight: '900', marginBottom: 16},
  noResponseText: {color: '#FF9800', fontSize: 22, fontWeight: '700', marginBottom: 8},
  callButton: {backgroundColor: '#4CAF50', paddingVertical: 18, borderRadius: 14, alignItems: 'center', marginBottom: 12},
  callButtonText: {color: '#fff', fontSize: 18, fontWeight: '700'},
  doneButton: {backgroundColor: '#1A1A1A', paddingVertical: 16, borderRadius: 14, alignItems: 'center', marginBottom: 32},
  doneButtonText: {color: '#ccc', fontSize: 16, fontWeight: '600'},
});

export default BuzzSheet;
