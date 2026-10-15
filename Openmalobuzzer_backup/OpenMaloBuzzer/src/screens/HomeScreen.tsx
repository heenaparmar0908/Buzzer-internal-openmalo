import React, {useState, useEffect, useCallback, useMemo} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import IonIcon from 'react-native-vector-icons/Ionicons';
import {User, Group} from '../types';
import {useUsers} from '../hooks/useUsers';
import {useGroups} from '../hooks/useGroups';
import {getRecentBuzzes} from '../services/firebase';

interface Props {
  currentUser: User;
  onSelectUser: (user: User) => void;
  onCallUser: (user: User) => void;
  onVoiceMail: (user?: User) => void;
  onSettings: () => void;
  onProfile: () => void;
  onHistory: () => void;
  onGroups: () => void;
  onBuzzGroup: (group: Group) => void;
}

const HomeScreen: React.FC<Props> = ({currentUser, onSelectUser, onCallUser, onVoiceMail, onSettings, onProfile, onHistory, onGroups, onBuzzGroup}) => {
  const {users, isOnline, loading} = useUsers(currentUser.id);
  const {groups} = useGroups();
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const {width} = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const canBuzz = (target: User) => {
    if (currentUser.role === 'owner' || currentUser.role === 'manager') return true;
    return target.role === 'owner' || target.role === 'manager';
  };

  useEffect(() => {
    getRecentBuzzes(currentUser.id, 50)
      .then(buzzes => {
        const seen = new Set<string>();
        const ids: string[] = [];
        for (const b of buzzes) {
          if (!seen.has(b.to_user_id)) {
            seen.add(b.to_user_id);
            ids.push(b.to_user_id);
          }
          if (ids.length >= 5) break;
        }
        setRecentIds(ids);
      })
      .catch(() => {});
  }, [currentUser.id]);

  const recentUsers = recentIds
    .map(id => users.find(u => u.id === id))
    .filter(Boolean) as User[];

  const buzzableUsers = users.filter(u => canBuzz(u));

  const myGroups = groups.filter(
    g => g.created_by === currentUser.id || g.member_ids.includes(currentUser.id),
  );

  const renderUser = ({item}: {item: User}) => {
    const online = isOnline(item);
    return (
      <View style={styles.userRow}>
        <TouchableOpacity style={styles.userLeft} onPress={() => onSelectUser(item)} activeOpacity={0.7}>
          <View style={[styles.avatar, online && styles.avatarOnline]}>
            <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
            <View style={[styles.dot, online ? styles.dotOn : styles.dotOff]} />
          </View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{item.name}</Text>
            <Text style={styles.userRole}>{item.role}{online ? ' · online' : ''}</Text>
          </View>
        </TouchableOpacity>
        <View style={styles.userActions}>
          <TouchableOpacity style={styles.callBtn} onPress={() => onCallUser(item)}>
            <Icon name="call" size={16} color="#4CAF50" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.vmBtn} onPress={() => onVoiceMail(item)}>
            <Icon name="voicemail" size={16} color="#FF9800" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.buzzBtn} onPress={() => onSelectUser(item)}>
            <Text style={styles.buzzBtnText}>Buzz</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, {paddingTop: insets.top + 8}]}>
        <Text style={styles.title}>Buzzer</Text>
        <View style={styles.headerRight}>
          {(currentUser.role === 'owner' || currentUser.role === 'manager') && (
            <TouchableOpacity style={styles.headerBtn} onPress={onHistory}><Text style={styles.headerBtnText}>Log</Text></TouchableOpacity>
          )}
          {currentUser.role === 'owner' && (
            <TouchableOpacity style={styles.headerBtn} onPress={onSettings}><Text style={styles.headerBtnText}>Settings</Text></TouchableOpacity>
          )}
          <TouchableOpacity style={styles.profileBtn} onPress={onProfile}>
            <Text style={styles.profileText}>{currentUser.name.charAt(0).toUpperCase()}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={buzzableUsers}
        renderItem={renderUser}
        keyExtractor={item => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: insets.bottom + 20}}
        ListHeaderComponent={
          <>
            {/* Quick Actions */}
            <View style={styles.actionBar}>
              <TouchableOpacity style={styles.actionCard} onPress={onGroups}>
                <Icon name="group" size={20} color="#ccc" />
                <Text style={styles.actionLabel}>Groups</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionCard} onPress={() => onVoiceMail()}>
                <Icon name="voicemail" size={20} color="#ccc" />
                <Text style={styles.actionLabel}>Voice Message</Text>
              </TouchableOpacity>
            </View>

            {/* Groups */}
            {myGroups.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>GROUPS</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupScroll}>
                  {myGroups.map(g => (
                    <TouchableOpacity key={g.id} style={styles.groupChip} onPress={() => onBuzzGroup(g)}>
                      <Text style={styles.groupChipText}>{g.name}</Text>
                      <Text style={styles.groupChipCount}>{g.member_ids.length}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            )}

            {/* Recent */}
            {recentUsers.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>RECENT</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentScroll}>
                  {recentUsers.map(u => (
                    <TouchableOpacity key={u.id} style={styles.recentItem} onPress={() => onSelectUser(u)}>
                      <View style={[styles.recentAvatar, isOnline(u) && styles.avatarOnline]}>
                        <Text style={styles.recentAvatarText}>{u.name.charAt(0).toUpperCase()}</Text>
                      </View>
                      <Text style={styles.recentName} numberOfLines={1}>{u.name.split(' ')[0]}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            )}

            <Text style={styles.sectionLabel}>PEOPLE</Text>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}><ActivityIndicator color="#FF4D4D" size="large" /></View>
          ) : (
            <View style={styles.center}><Text style={styles.emptyText}>No users available</Text></View>
          )
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0D0D0D'},

  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12},
  title: {fontSize: 26, fontWeight: '800', color: '#FF4D4D'},
  headerRight: {flexDirection: 'row', gap: 8, alignItems: 'center'},
  headerBtn: {backgroundColor: '#1A1A1A', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8},
  headerBtnText: {color: '#aaa', fontSize: 13, fontWeight: '600'},
  profileBtn: {width: 34, height: 34, borderRadius: 17, backgroundColor: '#FF4D4D', alignItems: 'center', justifyContent: 'center'},
  profileText: {color: '#fff', fontSize: 15, fontWeight: '800'},

  actionBar: {flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16},
  actionCard: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#1A1A1A', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12},
  actionEmoji: {fontSize: 18},
  actionLabel: {color: '#ccc', fontSize: 14, fontWeight: '600'},

  sectionLabel: {color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, marginTop: 12, marginBottom: 8},

  groupScroll: {paddingHorizontal: 16, gap: 8},
  groupChip: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1A1A1A', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20},
  groupChipText: {color: '#fff', fontSize: 13, fontWeight: '600'},
  groupChipCount: {color: '#888', fontSize: 11, backgroundColor: '#252525', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, overflow: 'hidden'},

  recentScroll: {paddingHorizontal: 16, gap: 16},
  recentItem: {alignItems: 'center', width: 56},
  recentAvatar: {width: 46, height: 46, borderRadius: 23, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', marginBottom: 4},
  recentAvatarText: {color: '#fff', fontSize: 18, fontWeight: '700'},
  recentName: {color: '#aaa', fontSize: 11, fontWeight: '500'},

  userRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
  userLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1},
  avatar: {width: 42, height: 42, borderRadius: 21, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', position: 'relative'},
  avatarOnline: {backgroundColor: '#1a3a1a'},
  avatarText: {color: '#fff', fontSize: 17, fontWeight: '700'},
  dot: {position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#0D0D0D'},
  dotOn: {backgroundColor: '#4CAF50'},
  dotOff: {backgroundColor: '#444'},
  userInfo: {flex: 1},
  userName: {color: '#fff', fontSize: 15, fontWeight: '600'},
  userRole: {color: '#666', fontSize: 12, marginTop: 1, textTransform: 'capitalize'},
  userActions: {flexDirection: 'row', gap: 6, alignItems: 'center'},
  callBtn: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#1a3a1a', alignItems: 'center', justifyContent: 'center'},
  callBtnIcon: {fontSize: 14},
  vmBtn: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#2a1515', alignItems: 'center', justifyContent: 'center'},
  vmBtnIcon: {color: '#FF9800', fontSize: 15, fontWeight: '700'},
  buzzBtn: {backgroundColor: '#FF4D4D', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8},
  buzzBtnText: {color: '#fff', fontSize: 13, fontWeight: '700'},

  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60},
  emptyText: {color: '#666', fontSize: 15},
});

export default HomeScreen;
