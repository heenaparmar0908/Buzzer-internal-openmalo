import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Linking} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {User} from '../types';
import {PRESENCE_TIMEOUT_MS} from '../constants';

interface Props {
  user: User;
  onBack: () => void;
  onBuzz: (user: User) => void;
  onCall: (user: User) => void;
  onVoiceMail: (user: User) => void;
}

const formatLastSeen = (lastSeenAt: number): {text: string; color: string} => {
  const diff = Date.now() - lastSeenAt;
  if (diff < PRESENCE_TIMEOUT_MS) return {text: 'Online now', color: '#4CAF50'};
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return {text: 'Just now', color: '#4CAF50'};
  if (mins < 60) return {text: `${mins}m ago`, color: '#FF9800'};
  const hours = Math.floor(mins / 60);
  if (hours < 24) return {text: `${hours}h ago`, color: '#FF9800'};
  const days = Math.floor(hours / 24);
  if (days === 1) return {text: '1 day ago', color: '#F44336'};
  return {text: `${days} days ago`, color: '#F44336'};
};

const UserProfileScreen: React.FC<Props> = ({user, onBack, onBuzz, onCall, onVoiceMail}) => {
  const insets = useSafeAreaInsets();
  const online = Date.now() - user.last_seen_at < PRESENCE_TIMEOUT_MS;
  const lastSeen = formatLastSeen(user.last_seen_at);

  return (
    <View style={styles.container}>
      <View style={[styles.header, {paddingTop: insets.top + 12}]}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{width: 50}} />
      </View>

      <View style={styles.content}>
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <View style={[styles.avatar, online && styles.avatarOnline]}>
            <Text style={styles.avatarText}>{user.name.charAt(0).toUpperCase()}</Text>
            <View style={[styles.statusDot, online ? styles.dotOn : styles.dotOff]} />
          </View>
          <Text style={styles.name}>{user.name}</Text>
          <Text style={styles.roleBadge}>{user.role}</Text>
        </View>

        {/* Last Seen */}
        <View style={styles.infoSection}>
          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Icon name={online ? 'wifi' : 'wifi-off'} size={20} color={lastSeen.color} />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Last seen</Text>
              <Text style={[styles.infoValue, {color: lastSeen.color}]}>{lastSeen.text}</Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <Icon name="phone" size={20} color="#888" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Phone</Text>
              <Text style={styles.infoValue}>{user.phone}</Text>
            </View>
          </View>

          <View style={[styles.infoRow, {borderBottomWidth: 0}]}>
            <View style={styles.infoIcon}>
              <Icon name="badge" size={20} color="#888" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Role</Text>
              <Text style={[styles.infoValue, {textTransform: 'capitalize'}]}>{user.role}</Text>
            </View>
          </View>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => onCall(user)}>
            <View style={[styles.actionIcon, {backgroundColor: '#1a3a1a'}]}>
              <Icon name="call" size={22} color="#4CAF50" />
            </View>
            <Text style={styles.actionLabel}>Call</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionBtn} onPress={() => onBuzz(user)}>
            <View style={[styles.actionIcon, {backgroundColor: '#1a3a1a'}]}>
              <Icon name="notifications-active" size={22} color="#4CAF50" />
            </View>
            <Text style={styles.actionLabel}>Buzz</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionBtn} onPress={() => onVoiceMail(user)}>
            <View style={[styles.actionIcon, {backgroundColor: '#2a1515'}]}>
              <Icon name="voicemail" size={22} color="#FF9800" />
            </View>
            <Text style={styles.actionLabel}>Voice</Text>
          </TouchableOpacity>
        </View>
      </View>
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
  content: {flex: 1, paddingHorizontal: 16},
  avatarSection: {alignItems: 'center', paddingVertical: 28},
  avatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#252525',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    position: 'relative',
  },
  avatarOnline: {backgroundColor: '#1a3a1a'},
  avatarText: {color: '#fff', fontSize: 38, fontWeight: '800'},
  statusDot: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: '#0D0D0D',
  },
  dotOn: {backgroundColor: '#4CAF50'},
  dotOff: {backgroundColor: '#444'},
  name: {color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 6},
  roleBadge: {
    color: '#FF4D4D',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    backgroundColor: '#2a1515',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
    letterSpacing: 1,
  },
  infoSection: {
    backgroundColor: '#1A1A1A',
    borderRadius: 14,
    marginBottom: 20,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#252525',
  },
  infoIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#252525',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  infoContent: {flex: 1},
  infoLabel: {color: '#666', fontSize: 12, fontWeight: '600', marginBottom: 2},
  infoValue: {color: '#fff', fontSize: 16, fontWeight: '600'},
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 32,
  },
  actionBtn: {alignItems: 'center', gap: 8},
  actionIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {color: '#ccc', fontSize: 13, fontWeight: '600'},
});

export default UserProfileScreen;
