import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Platform,
  Image,
  Keyboard,
  Modal,
  useWindowDimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Icon from 'react-native-vector-icons/MaterialIcons';

const BASE_WIDTH = 375;

interface Props {
  onResetPin: (phone: string, newPin: string, tenantCode: string) => Promise<void>;
  onBack: () => void;
}

const ForgotPinScreen: React.FC<Props> = ({onResetPin, onBack}) => {
  const [companyCode, setCompanyCode] = useState('');
  const [phone, setPhone] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [alertModal, setAlertModal] = useState<{visible: boolean; title: string; message: string; success?: boolean}>({visible: false, title: '', message: ''});

  useEffect(() => {
    AsyncStorage.getItem('@buzzer_last_phone').then(saved => {
      if (saved) setPhone(saved);
    });
    AsyncStorage.getItem('@buzzer_tenant').then(saved => {
      if (saved) setCompanyCode(saved);
    });
  }, []);

  const phoneRef = useRef<TextInput>(null);
  const pinRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const {width, height} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scale = Math.min(width / BASE_WIDTH, 1.3);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, e => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
      setTimeout(() => scrollRef.current?.scrollToEnd({animated: true}), 150);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const isFormValid =
    companyCode.trim().length > 0 &&
    phone.length >= 10 &&
    newPin.length === 4 &&
    confirmPin.length === 4;

  const handleReset = async () => {
    if (!companyCode.trim()) {
      setAlertModal({visible: true, title: 'Error', message: 'Enter your company code'});
      return;
    }
    if (phone.length < 10) {
      setAlertModal({visible: true, title: 'Error', message: 'Enter a valid phone number'});
      return;
    }
    if (newPin.length !== 4) {
      setAlertModal({visible: true, title: 'Error', message: 'Enter a 4-digit PIN'});
      return;
    }
    if (newPin !== confirmPin) {
      setAlertModal({visible: true, title: 'Error', message: 'PINs do not match'});
      return;
    }

    setLoading(true);
    try {
      await onResetPin(phone, newPin, companyCode.trim());
      setAlertModal({visible: true, title: 'PIN Reset Successful', message: 'Your PIN has been reset.\nYou can now login with your new PIN.', success: true});
    } catch (e: any) {
      setAlertModal({visible: true, title: 'Reset Failed', message: e?.message || 'Something went wrong. Try again.'});
    } finally {
      setLoading(false);
    }
  };

  const bottomPadding = keyboardVisible
    ? insets.bottom + (Platform.OS === 'ios' ? keyboardHeight + 20 : 120)
    : insets.bottom + 20;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={[
        styles.scrollContent,
        {
          paddingTop: insets.top + 20,
          paddingBottom: bottomPadding,
          paddingHorizontal: width * 0.08,
          justifyContent: keyboardVisible && Platform.OS === 'android' ? 'flex-start' : 'center',
        },
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      showsVerticalScrollIndicator={false}
      bounces={false}>

      <Image
        source={require('../assets/logo.png')}
        style={[styles.logoImage, {width: 70 * scale, height: 70 * scale}]}
      />
      <Text style={[styles.title, {fontSize: 28 * scale}]}>Reset PIN</Text>
      <Text
        style={[
          styles.subtitle,
          {fontSize: 14 * scale, marginBottom: height * 0.04},
        ]}>
        Enter your details to set a new PIN
      </Text>

      <TextInput
        style={[styles.input, {fontSize: 16 * scale, paddingVertical: 14 * scale}]}
        placeholder="Company Code (e.g. ACME)"
        placeholderTextColor="#999"
        autoCapitalize="characters"
        autoCorrect={false}
        value={companyCode}
        onChangeText={t => setCompanyCode(t.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}
        maxLength={20}
        returnKeyType="next"
        onSubmitEditing={() => phoneRef.current?.focus()}
      />

      <TextInput
        ref={phoneRef}
        style={[
          styles.input,
          {fontSize: 16 * scale, paddingVertical: 14 * scale},
          phone.length > 0 && phone.length < 10 && {borderColor: '#F44336'},
        ]}
        placeholder="Phone number"
        placeholderTextColor="#999"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={t => setPhone(t.replace(/[^0-9]/g, ''))}
        maxLength={15}
        returnKeyType="next"
        onSubmitEditing={() => pinRef.current?.focus()}
      />

      <TextInput
        ref={pinRef}
        style={[styles.input, {fontSize: 16 * scale, paddingVertical: 14 * scale}]}
        placeholder="New 4-digit PIN"
        placeholderTextColor="#999"
        keyboardType="number-pad"
        secureTextEntry
        value={newPin}
        onChangeText={setNewPin}
        maxLength={4}
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
      />

      <TextInput
        ref={confirmRef}
        style={[styles.input, {fontSize: 16 * scale, paddingVertical: 14 * scale}]}
        placeholder="Confirm new PIN"
        placeholderTextColor="#999"
        keyboardType="number-pad"
        secureTextEntry
        value={confirmPin}
        onChangeText={setConfirmPin}
        maxLength={4}
        returnKeyType="done"
        onSubmitEditing={handleReset}
      />

      <TouchableOpacity
        style={[
          styles.button,
          {paddingVertical: 16 * scale},
          (loading || !isFormValid) && styles.buttonDisabled,
        ]}
        onPress={handleReset}
        disabled={loading || !isFormValid}
        activeOpacity={0.8}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={[styles.buttonText, {fontSize: 16 * scale}]}>RESET PIN</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.loginLink}
        onPress={onBack}
        activeOpacity={0.7}>
        <Text style={[styles.loginText, {fontSize: 14 * scale}]}>
          Remember your PIN?{' '}
          <Text style={styles.loginHighlight}>Login</Text>
        </Text>
      </TouchableOpacity>

      <Modal
        visible={alertModal.visible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (alertModal.success) onBack();
          setAlertModal(prev => ({...prev, visible: false}));
        }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={[styles.modalIconWrap, alertModal.success && styles.modalIconWrapSuccess]}>
              <Icon
                name={alertModal.success ? 'check-circle' : 'error-outline'}
                size={32}
                color={alertModal.success ? '#4CAF50' : '#FF4D4D'}
              />
            </View>
            <Text style={styles.modalTitle}>{alertModal.title}</Text>
            <Text style={styles.modalMessage}>{alertModal.message}</Text>
            <TouchableOpacity
              style={[styles.modalBtn, alertModal.success && styles.modalBtnSuccess]}
              onPress={() => {
                setAlertModal(prev => ({...prev, visible: false}));
                if (alertModal.success) onBack();
              }}>
              <Text style={styles.modalBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  scrollContent: {
    flexGrow: 1,
  },
  logoImage: {
    alignSelf: 'center',
    marginBottom: 12,
  },
  title: {
    fontWeight: '800',
    color: '#FF4D4D',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    color: '#888',
    textAlign: 'center',
  },
  input: {
    backgroundColor: '#1A1A1A',
    color: '#fff',
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  button: {
    backgroundColor: '#FF4D4D',
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
  },
  loginLink: {
    marginTop: 24,
    alignItems: 'center',
  },
  loginText: {
    color: '#888',
  },
  loginHighlight: {
    color: '#FF4D4D',
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  modalBox: {
    backgroundColor: '#1A1A1A',
    borderRadius: 20,
    padding: 28,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  modalIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#3a1010',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  modalIconWrapSuccess: {
    backgroundColor: '#0a3a10',
  },
  modalTitle: {color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8},
  modalMessage: {color: '#888', fontSize: 18, textAlign: 'center', marginBottom: 24, lineHeight: 22},
  modalBtn: {width: '100%', backgroundColor: '#FF4D4D', paddingVertical: 14, borderRadius: 12, alignItems: 'center'},
  modalBtnSuccess: {backgroundColor: '#4CAF50'},
  modalBtnText: {color: '#fff', fontSize: 18, fontWeight: '700'},
});

export default ForgotPinScreen;
