import React, {useState, useEffect, useRef} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Platform, ScrollView} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Sound from 'react-native-sound';
import {BUZZ_SOUNDS, getSelectedSound, setSelectedSound as setSelectedSoundPref} from '../services/soundPreference';

interface Props {
  onBack: () => void;
}

const BuzzSoundScreen: React.FC<Props> = ({onBack}) => {
  const insets = useSafeAreaInsets();
  const [savedSound, setSavedSound] = useState('buzz_alarm');
  const [selectedSound, setSelectedSound] = useState('buzz_alarm');
  const [previewingSound, setPreviewingSound] = useState<string | null>(null);
  const previewRef = useRef<Sound | null>(null);
  const hasChanges = selectedSound !== savedSound;

  useEffect(() => {
    getSelectedSound().then(id => {
      setSavedSound(id);
      setSelectedSound(id);
    });
  }, []);

  useEffect(() => {
    return () => {
      previewRef.current?.stop();
      previewRef.current?.release();
    };
  }, []);

  const stopPreview = () => {
    if (previewRef.current) {
      previewRef.current.stop();
      previewRef.current.release();
      previewRef.current = null;
    }
    setPreviewingSound(null);
  };

  const handleTapSound = (soundId: string) => {
    setSelectedSound(soundId);
    // Preview the tapped sound
    stopPreview();
    const file = BUZZ_SOUNDS.find(s => s.id === soundId)?.file || 'buzz_alarm.wav';
    if (Platform.OS === 'ios') {
      Sound.setCategory('Playback');
    }
    setPreviewingSound(soundId);
    const s = new Sound(file, Sound.MAIN_BUNDLE, err => {
      if (err) { setPreviewingSound(null); return; }
      s.setVolume(0.5);
      s.setNumberOfLoops(0);
      s.play(() => {
        s.release();
        previewRef.current = null;
        setPreviewingSound(null);
      });
    });
    previewRef.current = s;
  };

  const handleSave = async () => {
    stopPreview();
    await setSelectedSoundPref(selectedSound);
    setSavedSound(selectedSound);
    onBack();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, {paddingTop: insets.top + 12}]}>
        <TouchableOpacity onPress={() => { stopPreview(); onBack(); }}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Buzz Sound</Text>
        <TouchableOpacity
          style={[styles.saveBtn, !hasChanges && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!hasChanges}>
          <Icon name="check" size={20} color="#fff" />
          <Text style={styles.saveBtnText}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{paddingBottom: insets.bottom + 16}}>
      <View style={styles.grid}>
        {BUZZ_SOUNDS.map(sound => {
          const isSelected = selectedSound === sound.id;
          const isPlaying = previewingSound === sound.id;
          return (
            <TouchableOpacity
              key={sound.id}
              style={[
                styles.card,
                isSelected && [styles.cardActive, {borderColor: sound.color}],
              ]}
              onPress={() => handleTapSound(sound.id)}
              activeOpacity={0.7}>
              <View style={[
                styles.iconWrap,
                {backgroundColor: isSelected ? sound.color + '20' : '#252525'},
              ]}>
                <Icon
                  name={isPlaying ? 'volume-up' : sound.icon}
                  size={28}
                  color={isSelected ? sound.color : '#666'}
                />
              </View>
              <Text style={[styles.label, isSelected && {color: '#fff'}]}>
                {sound.label}
              </Text>
              <Text style={[styles.tapHint, isSelected && {color: sound.color}]}>
                {isPlaying ? 'Playing...' : isSelected ? 'Selected' : 'Tap to preview'}
              </Text>
              {isSelected && (
                <View style={[styles.checkBadge, {backgroundColor: sound.color}]}>
                  <Icon name="check" size={14} color="#fff" />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{paddingHorizontal: 20}}>
        <Text style={styles.footerHint}>
          Selected sound will play when you receive a buzz
        </Text>
      </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0D0D0D'},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: {color: '#FF4D4D', fontSize: 20, fontWeight: '700'},
  headerTitle: {color: '#fff', fontSize: 22, fontWeight: '700'},
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FF4D4D',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  saveBtnDisabled: {opacity: 0.4},
  saveBtnText: {color: '#fff', fontSize: 14, fontWeight: '700'},
  scroll: {flex: 1},
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 12,
  },
  card: {
    width: '47%' as any,
    backgroundColor: '#1A1A1A',
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  cardActive: {backgroundColor: '#151015'},
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  label: {color: '#aaa', fontSize: 16, fontWeight: '700', marginBottom: 4},
  tapHint: {color: '#555', fontSize: 11, fontWeight: '600'},
  checkBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerHint: {
    color: '#444',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 16,
  },
});

export default BuzzSoundScreen;
