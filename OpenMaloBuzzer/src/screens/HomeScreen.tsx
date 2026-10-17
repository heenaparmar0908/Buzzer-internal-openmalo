import React, {useState, useEffect, useRef, useCallback} from 'react';
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
  Dimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Sound from 'react-native-sound';
import {User, Group, Buzz, VoiceMail} from '../types';
import {useUsers} from '../hooks/useUsers';
import {useGroups} from '../hooks/useGroups';
import {getRecentBuzzes, subscribeToVoiceMails, subscribeToMissedBuzzes, markVoiceMailListened, subscribeToUsers} from '../services/firebase';

interface Props {
  currentUser: User;
  onSelectUser: (user: User) => void;
  onBuzzAgain: (user: User, reason: string) => void;
  onEditBuzz: (user: User, reason: string) => void;
  onCallUser: (user: User) => void;
  onVoiceMail: (user?: User) => void;
  onSettings: () => void;
  onProfile: () => void;
  onHistory: () => void;
  onGroups: () => void;
  onBuzzGroup: (group: Group) => void;
}

const HomeScreen: React.FC<Props> = ({currentUser, onSelectUser, onBuzzAgain, onEditBuzz, onCallUser, onVoiceMail, onSettings, onProfile, onHistory, onGroups, onBuzzGroup}) => {
  const {users, isOnline, loading} = useUsers(currentUser.id);
  const {groups} = useGroups();
  const [recentBuzzes, setRecentBuzzes] = useState<Buzz[]>([]);
  const [recentGroups, setRecentGroups] = useState<{groupId: string; groupName: string; reason: string; memberCount: number}[]>([]);
  const [unreadVoiceCount, setUnreadVoiceCount] = useState(0);
  const [missedBuzzes, setMissedBuzzes] = useState<Buzz[]>([]);
  const [infoGroup, setInfoGroup] = useState<Group | null>(null);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'recent' | 'people' | 'groups' | 'voice'>('recent');
  const [voiceMails, setVoiceMails] = useState<VoiceMail[]>([]);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const soundRef = useRef<Sound | null>(null);
  const pagerRef = useRef<ScrollView>(null);
  const screenWidth = Dimensions.get('window').width;
  const TABS: ('recent' | 'people' | 'groups' | 'voice')[] = ['recent', 'people', 'groups', 'voice'];

  const scrollToTab = useCallback((tab: 'recent' | 'people' | 'groups' | 'voice') => {
    const index = TABS.indexOf(tab);
    pagerRef.current?.scrollTo({x: index * screenWidth, animated: true});
    setActiveTab(tab);
  }, [screenWidth]);

  const handleSwipe = useCallback((e: any) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
    if (index >= 0 && index < TABS.length) {
      setActiveTab(TABS[index]);
    }
  }, [screenWidth]);
  const insets = useSafeAreaInsets();

  const canBuzz = (target: User) => {
    if (currentUser.role === 'owner' || currentUser.role === 'manager') return true;
    return target.role === 'owner' || target.role === 'manager';
  };

  useEffect(() => {
    getRecentBuzzes(currentUser.id, 50)
      .then(buzzes => {
        // Separate group buzzes and individual buzzes
        const seenGroups = new Set<string>();
        const groupEntries: {groupId: string; groupName: string; reason: string; memberCount: number}[] = [];
        const seen = new Set<string>();
        const recent: Buzz[] = [];

        for (const b of buzzes) {
          if (b.response === 'cancelled') continue;

          // Group buzz
          if (b.group_id) {
            const gKey = `${b.group_id}_${b.reason}`;
            if (!seenGroups.has(gKey)) {
              seenGroups.add(gKey);
              const count = buzzes.filter(x => x.group_id === b.group_id && x.reason === b.reason && x.response !== 'cancelled').length;
              groupEntries.push({groupId: b.group_id, groupName: b.group_name || 'Group', reason: b.reason, memberCount: count});
            }
            continue;
          }

          // Individual buzz
          const key = `${b.to_user_id}_${b.reason}`;
          if (!seen.has(key)) {
            seen.add(key);
            recent.push(b);
          }
        }
        recent.splice(10);
        setRecentBuzzes(recent);
        setRecentGroups(groupEntries);
      })
      .catch(() => {});
  }, [currentUser.id]);

  useEffect(() => {
    const unsub = subscribeToVoiceMails(currentUser.id, mails => {
      setVoiceMails(mails);
      setUnreadVoiceCount(mails.filter(m => !m.listened).length);
    });
    const unsub2 = subscribeToUsers(u => {
      const map: Record<string, string> = {};
      u.forEach(user => { map[user.id] = user.name; });
      setUsersMap(map);
    });
    return () => { unsub(); unsub2(); };
  }, [currentUser.id]);

  useEffect(() => {
    return () => {
      if (soundRef.current) { soundRef.current.stop(); soundRef.current.release(); }
    };
  }, []);

  const playVoiceMail = (mail: VoiceMail) => {
    if (playingId === mail.id) {
      if (soundRef.current) { soundRef.current.stop(); soundRef.current.release(); soundRef.current = null; }
      setPlayingId(null);
      return;
    }
    if (soundRef.current) { soundRef.current.stop(); soundRef.current.release(); soundRef.current = null; }
    setPlayingId(mail.id);
    if (!mail.listened) markVoiceMailListened(mail.id).catch(() => {});
    const s = new Sound(mail.audio_url, '', (err) => {
      if (err) { setPlayingId(null); return; }
      s.setVolume(1.0);
      s.play(() => { s.release(); soundRef.current = null; setPlayingId(null); });
    });
    soundRef.current = s;
  };

  const formatVoiceDate = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    return `${d.toLocaleDateString([], {month: 'short', day: 'numeric'})} ${time}`;
  };

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    const unsub = subscribeToMissedBuzzes(currentUser.id, setMissedBuzzes);
    return unsub;
  }, [currentUser.id]);

  const getGroupMissedCount = (group: Group) =>
    missedBuzzes.filter(b => group.member_ids.includes(b.from_user_id)).length;

  const getUserName = (id: string) => {
    const u = users.find(u => u.id === id);
    return u?.name || '?';
  };

  const buzzableUsers = users.filter(u => {
    if (!canBuzz(u)) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return u.name.toLowerCase().includes(q) || (u.phone && u.phone.includes(q));
    }
    return true;
  });

  const myGroups = groups.filter(g =>
    g.created_by === currentUser.id || g.member_ids.includes(currentUser.id),
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
            <Text style={styles.userRole}>{item.role}</Text>
          </View>
        </TouchableOpacity>
        <View style={styles.userActions}>
          <TouchableOpacity style={styles.callBtn} onPress={() => onCallUser(item)}>
            <Icon name="call" size={20} color="#4CAF50" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.vmBtn} onPress={() => onVoiceMail(item)}>
            <Icon name="voicemail" size={20} color="#FF9800" />
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

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity style={[styles.tab, activeTab === 'recent' && styles.tabActive]} onPress={() => scrollToTab('recent')}>
          <Text style={[styles.tabText, activeTab === 'recent' && styles.tabTextActive]}>Recent</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, activeTab === 'people' && styles.tabActive]} onPress={() => scrollToTab('people')}>
          <Text style={[styles.tabText, activeTab === 'people' && styles.tabTextActive]}>People</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, activeTab === 'groups' && styles.tabActive]} onPress={() => scrollToTab('groups')}>
          <Text style={[styles.tabText, activeTab === 'groups' && styles.tabTextActive]}>Groups</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, activeTab === 'voice' && styles.tabActive]} onPress={() => scrollToTab('voice')}>
          <Text style={[styles.tabText, activeTab === 'voice' && styles.tabTextActive]}>Voice</Text>
          {unreadVoiceCount > 0 && (
            <View style={styles.tabBadge}><Text style={styles.tabBadgeText}>{unreadVoiceCount}</Text></View>
          )}
        </TouchableOpacity>
      </View>

      {activeTab === 'people' && (
        <View style={styles.searchBar}>
          <Icon name="search" size={18} color="#888" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search people..."
            placeholderTextColor="#666"
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <Icon name="close" size={18} color="#888" />
            </TouchableOpacity>
          )}
        </View>
      )}

      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleSwipe}
        scrollEventThrottle={16}
        style={{flex: 1}}>

        {/* Recent Tab */}
        <ScrollView style={{width: screenWidth}} contentContainerStyle={{paddingBottom: insets.bottom + 20}} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {recentGroups.length > 0 && recentGroups.map(rg => {
            const group = groups.find(g => g.id === rg.groupId);
            return (
              <View key={`grp_${rg.groupId}_${rg.reason}`} style={styles.recentRow}>
                <View style={styles.recentGroupAvatar}>
                  <Icon name="group" size={22} color="#ccc" />
                </View>
                <View style={styles.recentInfo}>
                  <Text style={styles.recentName}>{rg.groupName}</Text>
                  <Text style={styles.recentReason} numberOfLines={1}>{rg.reason} · {rg.memberCount} members</Text>
                </View>
                {group && (
                  <TouchableOpacity style={styles.buzzBtn} onPress={() => onBuzzGroup(group)}>
                    <Text style={styles.buzzBtnText}>Buzz</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
          {recentBuzzes.length > 0 ? (
            recentBuzzes.map(b => {
              const targetUser = users.find(u => u.id === b.to_user_id);
              const name = getUserName(b.to_user_id);
              return (
                <View key={b.id} style={styles.recentRow}>
                  <TouchableOpacity style={styles.recentEditBtn} onPress={() => targetUser && onEditBuzz(targetUser, b.reason)}>
                    <Icon name="edit" size={18} color="#64B5F6" />
                  </TouchableOpacity>
                  <View style={[styles.recentAvatar, targetUser && isOnline(targetUser) && styles.avatarOnline]}>
                    <Text style={styles.recentAvatarText}>{name.charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.recentInfo}>
                    <Text style={styles.recentName}>{name}</Text>
                    <Text style={styles.recentReason} numberOfLines={1}>{b.reason}</Text>
                  </View>
                  <TouchableOpacity style={styles.buzzBtn} onPress={() => targetUser && onBuzzAgain(targetUser, b.reason)}>
                    <Text style={styles.buzzBtnText}>Buzz</Text>
                  </TouchableOpacity>
                </View>
              );
            })
          ) : recentGroups.length === 0 ? (
            <View style={styles.center}><Text style={styles.emptyText}>No recent buzzes</Text></View>
          ) : null}
        </ScrollView>

        {/* People Tab */}
        <View style={{width: screenWidth}}>
          <FlatList
            data={buzzableUsers}
            renderItem={renderUser}
            keyExtractor={item => item.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{paddingBottom: insets.bottom + 20}}
            nestedScrollEnabled
            ListEmptyComponent={
              loading ? (
                <View style={styles.center}><ActivityIndicator color="#FF4D4D" size="large" /></View>
              ) : (
                <View style={styles.center}><Text style={styles.emptyText}>No users available</Text></View>
              )
            }
          />
        </View>

        {/* Groups Tab */}
        <ScrollView style={{width: screenWidth}} contentContainerStyle={{paddingBottom: insets.bottom + 20}} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {(currentUser.role === 'owner' || currentUser.role === 'manager') && (
            <TouchableOpacity style={styles.createGroupBtn} onPress={onGroups} activeOpacity={0.7}>
              <Icon name="add-circle" size={24} color="#64B5F6" />
              <Text style={styles.createGroupBtnText}>Create Group</Text>
            </TouchableOpacity>
          )}
          {myGroups.length > 0 ? (
            myGroups.map(g => {
              const missed = getGroupMissedCount(g);
              const canBuzzGroup = currentUser.role === 'owner' || currentUser.role === 'manager';
              return (
                <View key={g.id} style={styles.groupRow}>
                  <TouchableOpacity style={styles.groupRowLeft} onPress={onGroups} activeOpacity={0.7}>
                    <View style={styles.groupAvatar}>
                      <Icon name="group" size={24} color="#ccc" />
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
                      <Icon name="info-outline" size={22} color="#888" />
                    </TouchableOpacity>
                    {canBuzzGroup && (
                      <TouchableOpacity style={styles.buzzBtn} onPress={() => onBuzzGroup(g)}>
                        <Text style={styles.buzzBtnText}>Buzz</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })
          ) : (
            <View style={styles.center}><Text style={styles.emptyText}>No groups</Text></View>
          )}
        </ScrollView>

        {/* Voice Tab */}
        <ScrollView style={{width: screenWidth}} contentContainerStyle={{paddingBottom: insets.bottom + 20}} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {voiceMails.length > 0 ? (
            voiceMails.map(mail => {
              const isPlaying = playingId === mail.id;
              const senderName = mail.from_user_name || usersMap[mail.from_user_id] || 'Unknown';
              return (
                <TouchableOpacity
                  key={mail.id}
                  style={[styles.voiceRow, !mail.listened && styles.voiceRowUnread]}
                  onPress={() => playVoiceMail(mail)}
                  activeOpacity={0.7}>
                  <View style={styles.voiceAvatar}>
                    <Text style={styles.voiceAvatarText}>{senderName.charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.voiceInfo}>
                    <Text style={styles.voiceName}>{senderName}</Text>
                    <Text style={styles.voiceMeta}>{formatDuration(mail.duration_seconds)} · {formatVoiceDate(mail.created_at)}</Text>
                  </View>
                  <View style={[styles.voicePlayBtn, isPlaying && styles.voicePlayBtnActive]}>
                    <Icon name={isPlaying ? 'pause' : 'play-arrow'} size={20} color={isPlaying ? '#fff' : '#ccc'} />
                  </View>
                  {!mail.listened && <View style={styles.voiceUnreadDot} />}
                </TouchableOpacity>
              );
            })
          ) : (
            <View style={styles.center}><Text style={styles.emptyText}>No voice messages</Text></View>
          )}
        </ScrollView>

      </ScrollView>
      <Modal visible={!!infoGroup} transparent animationType="fade" onRequestClose={() => setInfoGroup(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{infoGroup?.name}</Text>
              <TouchableOpacity onPress={() => setInfoGroup(null)}>
                <Icon name="close" size={24} color="#888" />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSubtitle}>{infoGroup?.member_ids.length} members · Created by {infoGroup?.created_by === currentUser.id ? 'You' : (users.find(u => u.id === infoGroup?.created_by)?.name || 'Unknown')}</Text>
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
  title: {fontSize: 28, fontWeight: '800', color: '#FF4D4D'},
  headerRight: {flexDirection: 'row', gap: 8, alignItems: 'center'},
  headerBtn: {backgroundColor: '#1A1A1A', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8},
  headerBtnText: {color: '#aaa', fontSize: 15, fontWeight: '600'},
  profileBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#FF4D4D', alignItems: 'center', justifyContent: 'center'},
  profileText: {color: '#fff', fontSize: 16, fontWeight: '800'},

  tabBar: {flexDirection: 'row', paddingHorizontal: 12, marginBottom: 8, gap: 6},
  tab: {flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: '#1A1A1A', flexDirection: 'row', justifyContent: 'center', gap: 4},
  tabActive: {backgroundColor: '#1a2a3a', borderWidth: 1, borderColor: '#64B5F6'},
  tabText: {color: '#888', fontSize: 14, fontWeight: '600'},
  tabTextActive: {color: '#64B5F6', fontWeight: '700'},
  tabBadge: {backgroundColor: '#FF4D4D', minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4},
  tabBadgeText: {color: '#fff', fontSize: 10, fontWeight: '800'},

  searchBar: {flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A1A', marginHorizontal: 16, borderRadius: 10, paddingHorizontal: 12, height: 42, gap: 8, marginBottom: 12},
  searchInput: {flex: 1, color: '#fff', fontSize: 15, padding: 0},

  groupRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
  groupRowLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1},
  groupAvatar: {width: 42, height: 42, borderRadius: 21, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center'},
  groupRowInfo: {flex: 1},
  groupRowName: {color: '#fff', fontSize: 16, fontWeight: '600'},
  groupRowCount: {color: '#999', fontSize: 13, marginTop: 1},

  recentRow: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1A1A1A'},
  recentEditBtn: {width: 34, height: 34, borderRadius: 17, backgroundColor: '#1a2a3a', alignItems: 'center', justifyContent: 'center', marginRight: 10},
  recentAvatar: {width: 44, height: 44, borderRadius: 22, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', marginRight: 12},
  recentAvatarText: {color: '#fff', fontSize: 18, fontWeight: '700'},
  recentGroupAvatar: {width: 44, height: 44, borderRadius: 22, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', marginRight: 12},
  recentInfo: {flex: 1},
  recentName: {color: '#fff', fontSize: 16, fontWeight: '600'},
  recentReason: {color: '#FF4D4D', fontSize: 14, fontWeight: '600', marginTop: 2},

  userRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10},
  userLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1},
  avatar: {width: 44, height: 44, borderRadius: 22, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', position: 'relative'},
  avatarOnline: {backgroundColor: '#1a3a1a'},
  avatarText: {color: '#fff', fontSize: 18, fontWeight: '700'},
  dot: {position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#0D0D0D'},
  dotOn: {backgroundColor: '#4CAF50'},
  dotOff: {backgroundColor: '#444'},
  userInfo: {flex: 1},
  userName: {color: '#fff', fontSize: 16, fontWeight: '600'},
  userRole: {color: '#999', fontSize: 13, marginTop: 1, textTransform: 'capitalize'},
  userActions: {flexDirection: 'row', gap: 6, alignItems: 'center'},
  callBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a3a1a', alignItems: 'center', justifyContent: 'center'},
  vmBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#2a1515', alignItems: 'center', justifyContent: 'center'},
  buzzBtn: {backgroundColor: '#4CAF50', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8},
  buzzBtnText: {color: '#fff', fontSize: 14, fontWeight: '700'},

  badge: {backgroundColor: '#FF4D4D', minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  badgeText: {color: '#fff', fontSize: 12, fontWeight: '800'},
  groupActions: {flexDirection: 'row', gap: 8, alignItems: 'center'},
  groupInfoBtn: {width: 34, height: 34, borderRadius: 17, backgroundColor: '#1A1A1A', alignItems: 'center', justifyContent: 'center'},
  createGroupBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, marginBottom: 12, padding: 14, backgroundColor: '#1A1A1A', borderRadius: 12, borderWidth: 1, borderColor: '#333', borderStyle: 'dashed'},
  createGroupBtnText: {color: '#64B5F6', fontSize: 16, fontWeight: '700'},

  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32},
  modalBox: {backgroundColor: '#1A1A1A', borderRadius: 20, padding: 20, width: '100%', maxHeight: '60%', borderWidth: 1, borderColor: '#333'},
  modalHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4},
  modalTitle: {color: '#fff', fontSize: 22, fontWeight: '800'},
  modalSubtitle: {color: '#888', fontSize: 14, marginBottom: 16},
  memberList: {maxHeight: 300},
  memberRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#252525'},
  memberAvatar: {width: 38, height: 38, borderRadius: 19, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', marginRight: 12},
  memberAvatarText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  memberInfo: {flex: 1},
  memberName: {color: '#fff', fontSize: 15, fontWeight: '600'},
  memberRole: {color: '#999', fontSize: 13, textTransform: 'capitalize'},

  voiceRow: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1A1A1A'},
  voiceRowUnread: {borderLeftWidth: 3, borderLeftColor: '#FF4D4D'},
  voiceAvatar: {width: 44, height: 44, borderRadius: 22, backgroundColor: '#252525', alignItems: 'center', justifyContent: 'center', marginRight: 12},
  voiceAvatarText: {color: '#fff', fontSize: 18, fontWeight: '700'},
  voiceInfo: {flex: 1},
  voiceName: {color: '#fff', fontSize: 16, fontWeight: '600'},
  voiceMeta: {color: '#999', fontSize: 13, marginTop: 2},
  voicePlayBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#1A1A1A', alignItems: 'center', justifyContent: 'center'},
  voicePlayBtnActive: {backgroundColor: '#FF4D4D'},
  voiceUnreadDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF4D4D', position: 'absolute', top: 10, right: 10},

  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60},
  emptyText: {color: '#999', fontSize: 16},
});

export default HomeScreen;
