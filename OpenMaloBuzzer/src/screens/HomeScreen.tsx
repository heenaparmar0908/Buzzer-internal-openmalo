import React, {useState, useEffect} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Modal,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {User, Group, Buzz} from '../types';
import {useUsers} from '../hooks/useUsers';
import {useGroups} from '../hooks/useGroups';
import {getRecentBuzzes, subscribeToVoiceMails, subscribeToMissedBuzzes} from '../services/firebase';

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
  const [unreadVoiceCount, setUnreadVoiceCount] = useState(0);
  const [missedBuzzes, setMissedBuzzes] = useState<Buzz[]>([]);
  const [search, setSearch] = useState('');
  const [infoGroup, setInfoGroup] = useState<Group | null>(null);
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

  useEffect(() => {
    const unsub = subscribeToVoiceMails(currentUser.id, mails => {
      setUnreadVoiceCount(mails.filter(m => !m.listened).length);
    });
    return unsub;
  }, [currentUser.id]);

  useEffect(() => {
    const unsub = subscribeToMissedBuzzes(currentUser.id, setMissedBuzzes);
    return unsub;
  }, [currentUser.id]);

  const getGroupMissedCount = (group: Group) =>
    missedBuzzes.filter(b => group.member_ids.includes(b.from_user_id)).length;

  const recentUsers = recentIds
    .map(id => users.find(u => u.id === id))
    .filter(Boolean) as User[];

  const buzzableUsers = users.filter(u => {
    if (!canBuzz(u)) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return u.name.toLowerCase().includes(q) || (u.phone && u.phone.includes(q));
    }
    return true;
  });

  const myGroups = groups.filter(g => {
    if (g.created_by !== currentUser.id && !g.member_ids.includes(currentUser.id)) return false;
    if (search.trim()) {
      return g.name.toLowerCase().includes(search.trim().toLowerCase());
    }
    return true;
  });

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
            <Text style={styles.userRole}>{item.role}</Text>
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
          <TouchableOpacity style={styles.headerBtn} onPress={onHistory}><Text style={styles.headerBtnText}>Log</Text></TouchableOpacity>
          {currentUser.role === 'owner' && (
            <TouchableOpacity style={styles.headerBtn} onPress={onSettings}><Text style={styles.headerBtnText}>Settings</Text></TouchableOpacity>
          )}
          <TouchableOpacity style={styles.profileBtn} onPress={onProfile}>
            <Text style={styles.profileText}>{currentUser.name.charAt(0).toUpperCase()}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchBar}>
        <Icon name="search" size={18} color="#666" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search people or groups..."
          placeholderTextColor="#666"
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Icon name="close" size={18} color="#666" />
          </TouchableOpacity>
        )}
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
                <Text style={styles.actionLabel}>Groups ({myGroups.length})</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionCard} onPress={() => onVoiceMail()}>
                <Icon name="voicemail" size={20} color="#ccc" />
                <Text style={styles.actionLabel}>Voice Message</Text>
                {unreadVoiceCount > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{unreadVoiceCount}</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {/* Groups */}
            {myGroups.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>GROUPS</Text>
                {myGroups.map(g => {
                  const missed = getGroupMissedCount(g);
                  const canBuzzGroup = currentUser.role === 'owner' || currentUser.role === 'manager';
                  return (
                    <View key={g.id} style={styles.groupRow}>
                      <TouchableOpacity style={styles.groupRowLeft} onPress={onGroups} activeOpacity={0.7}>
                        <View style={styles.groupAvatar}>
                          <Icon name="group" size={20} color="#ccc" />
                        </View>
                        <View style={styles.groupRowInfo}>
                          <Text style={styles.groupRowName}>{g.name}</Text>
                          <Text style={styles.groupRowCount}>{g.member_ids.length} members</Text>
                        </View>
                        {missed > 0 && (
                          <View style={styles.badge}>
                            <Text style={styles.badgeText}>{missed}</Text>
                          </View>
                        )}
                      </TouchableOpacity>
                      <View style={styles.groupActions}>
                        <TouchableOpacity style={styles.groupInfoBtn} onPress={() => setInfoGroup(g)}>
                          <Icon name="info-outline" size={18} color="#888" />
                        </TouchableOpacity>
                        {canBuzzGroup && (
                          <TouchableOpacity style={styles.buzzBtn} onPress={() => onBuzzGroup(g)}>
                            <Text style={styles.buzzBtnText}>Buzz</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
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
      <Modal visible={!!infoGroup} transparent animationType="fade" onRequestClose={() => setInfoGroup(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{infoGroup?.name}</Text>
              <TouchableOpacity onPress={() => setInfoGroup(null)}>
                <Icon name="close" size={22} color="#888" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSubtitle}>{infoGroup?.member_ids.length} members</Text>
            <ScrollView style={styles.memberList}>
              {infoGroup?.member_ids.map(id => {
                const member = id === currentUser.id ? currentUser : users.find(u => u.id === id);
                return (
                  <View key={id} style={styles.memberRow}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>{id === currentUser.id ? 'Y' : (member?.name || '?').charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={styles.memberInfo}>
                      <Text style={styles.memberName}>{id === currentUser.id ? 'You' : (member?.name || 'Unknown')}</Text>
                      <Text style={styles.memberRole}>{member?.role || ''}</Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  actionLabel: {color: '#ccc', fontSize: 14, fontWeight: '600', flex: 1},

  sectionLabel: {color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, marginTop: 12, marginBottom: 8},
  searchBar: {flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A1A', marginHorizontal: 16, borderRadius: 10, paddingHorizontal: 12, height: 40, gap: 8, marginBottom: 12},
  searchInput: {flex: 1, color: '#fff', fontSize: 14, padding: 0},

  groupRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
  groupRowLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1},
  groupAvatar: {width: 42, height: 42, borderRadius: 21, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center'},
  groupRowInfo: {flex: 1},
  groupRowName: {color: '#fff', fontSize: 15, fontWeight: '600'},
  groupRowCount: {color: '#666', fontSize: 12, marginTop: 1},

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
  vmBtn: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#2a1515', alignItems: 'center', justifyContent: 'center'},
  buzzBtn: {backgroundColor: '#FF4D4D', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8},
  buzzBtnText: {color: '#fff', fontSize: 13, fontWeight: '700'},

  badge: {backgroundColor: '#FF4D4D', minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  badgeText: {color: '#fff', fontSize: 11, fontWeight: '800'},
  groupActions: {flexDirection: 'row', gap: 8, alignItems: 'center'},
  groupInfoBtn: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#1A1A1A', alignItems: 'center', justifyContent: 'center'},

  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32},
  modalBox: {backgroundColor: '#1A1A1A', borderRadius: 20, padding: 20, width: '100%', maxHeight: '60%', borderWidth: 1, borderColor: '#333'},
  modalHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4},
  modalTitle: {color: '#fff', fontSize: 20, fontWeight: '800'},
  modalSubtitle: {color: '#888', fontSize: 13, marginBottom: 16},
  memberList: {maxHeight: 300},
  memberRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#252525'},
  memberAvatar: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', marginRight: 12},
  memberAvatarText: {color: '#fff', fontSize: 15, fontWeight: '700'},
  memberInfo: {flex: 1},
  memberName: {color: '#fff', fontSize: 14, fontWeight: '600'},
  memberRole: {color: '#666', fontSize: 12, textTransform: 'capitalize'},

  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60},
  emptyText: {color: '#666', fontSize: 15},
});

export default HomeScreen;
