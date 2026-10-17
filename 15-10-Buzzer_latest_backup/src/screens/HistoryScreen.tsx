import React, {useState, useEffect, useCallback, useRef} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {Buzz, User} from '../types';
import {getBuzzLogPage, getUsers} from '../services/firebase';

interface Props {
  currentUser: User;
  onBack: () => void;
}

const RESPONSE_MAP: Record<string, {label: string; color: string; icon: string}> = {
  ack: {label: 'Acknowledged', color: '#4CAF50', icon: 'check-circle'},
  five_min: {label: '5 minutes', color: '#FF9800', icon: 'timer'},
  busy: {label: 'Busy', color: '#F44336', icon: 'cancel'},
  cancelled: {label: 'Cancelled', color: '#888', icon: 'block'},
  dismissed: {label: 'Dismissed', color: '#9C27B0', icon: 'visibility'},
  none: {label: 'No response', color: '#555', icon: '—'},
};

const HistoryScreen: React.FC<Props> = ({currentUser, onBack}) => {
  const insets = useSafeAreaInsets();
  const [buzzes, setBuzzes] = useState<Buzz[]>([]);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [hasMore, setHasMore] = useState(true);
  const lastDocRef = useRef<any>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [page, userList] = await Promise.all([
          getBuzzLogPage(),
          getUsers(),
        ]);
        const filtered = currentUser.role === 'member'
          ? page.buzzes.filter(b => b.from_user_id === currentUser.id || b.to_user_id === currentUser.id)
          : page.buzzes;
        setBuzzes(filtered);
        lastDocRef.current = page.lastDoc;
        setHasMore(page.hasMore);
        const map: Record<string, string> = {};
        userList.forEach(u => { map[u.id] = u.name; });
        setUsersMap(map);
      } catch (err) {
        console.warn('Failed to load buzz log:', err);
      }
      setLoading(false);
    };
    load();
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await getBuzzLogPage(lastDocRef.current);
      const filtered = currentUser.role === 'member'
        ? page.buzzes.filter(b => b.from_user_id === currentUser.id || b.to_user_id === currentUser.id)
        : page.buzzes;
      setBuzzes(prev => [...prev, ...filtered]);
      lastDocRef.current = page.lastDoc;
      setHasMore(page.hasMore);
    } catch (err) {
      console.warn('Failed to load more buzzes:', err);
    }
    setLoadingMore(false);
  }, [loadingMore, hasMore]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (isToday) return `Today, ${time}`;
    if (isYesterday) return `Yesterday, ${time}`;
    return `${d.toLocaleDateString([], {month: 'short', day: 'numeric'})} ${time}`;
  };

  const responseTime = (buzz: Buzz) => {
    if (!buzz.responded_at) return '';
    const diff = Math.round((buzz.responded_at - buzz.created_at) / 1000);
    return diff < 60 ? `${diff}s` : `${Math.floor(diff / 60)}m ${diff % 60}s`;
  };

  const renderItem = ({item}: {item: Buzz}) => {
    const resp = RESPONSE_MAP[item.response] || RESPONSE_MAP.none;
    const fromName = item.from_user_id === currentUser.id ? 'You' : (usersMap[item.from_user_id] || '?');
    const toName = item.to_user_id === currentUser.id ? 'You' : (usersMap[item.to_user_id] || '?');
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.avatarRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{fromName.charAt(0)}</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{toName.charAt(0)}</Text>
            </View>
            <View style={styles.namesCol}>
              <Text style={styles.names}>{fromName} → {toName}</Text>
              <Text style={styles.time}>{formatTime(item.created_at)}</Text>
            </View>
          </View>
          {item.escalated && (
            <View style={styles.escalatedBadge}>
              <Text style={styles.escalatedText}>ESCALATED</Text>
            </View>
          )}
        </View>
        <View style={styles.reasonRow}>
          <Text style={styles.reason}>{item.reason}</Text>
          {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
        </View>
        <View style={styles.responseRow}>
          <View style={[styles.responseBadge, {backgroundColor: resp.color + '20', borderColor: resp.color + '40'}]}>
            <Icon name={resp.icon} size={14} color={resp.color} />
            <Text style={[styles.responseLabel, {color: resp.color}]}>{resp.label}</Text>
          </View>
          {responseTime(item) ? (
            <Text style={styles.responseTime}>Responded in {responseTime(item)}</Text>
          ) : null}
        </View>
      </View>
    );
  };

  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator color="#FF4D4D" size="small" />
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, {paddingTop: insets.top + 12}]}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{currentUser.role === 'member' ? 'My Buzzes' : 'Buzz Log'}</Text>
        <View style={styles.periodBadge}>
          <Text style={styles.periodText}>30 days</Text>
        </View>
      </View>
      <View style={styles.filterBar}>
        <TouchableOpacity style={[styles.filterChip, filter === 'all' && styles.filterChipActive]} onPress={() => setFilter('all')}>
          <Text style={[styles.filterChipText, filter === 'all' && styles.filterChipTextActive]}>All ({buzzes.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, filter === 'ack' && {backgroundColor: '#4CAF5030', borderColor: '#4CAF50'}]} onPress={() => setFilter('ack')}>
          <Text style={[styles.filterChipText, filter === 'ack' && {color: '#4CAF50'}]}>Ack ({buzzes.filter(b => b.response === 'ack').length})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, filter === 'five_min' && {backgroundColor: '#FF980030', borderColor: '#FF9800'}]} onPress={() => setFilter('five_min')}>
          <Text style={[styles.filterChipText, filter === 'five_min' && {color: '#FF9800'}]}>5 min ({buzzes.filter(b => b.response === 'five_min').length})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, filter === 'busy' && {backgroundColor: '#F4433630', borderColor: '#F44336'}]} onPress={() => setFilter('busy')}>
          <Text style={[styles.filterChipText, filter === 'busy' && {color: '#F44336'}]}>Busy ({buzzes.filter(b => b.response === 'busy').length})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.filterChip, filter === 'none' && {backgroundColor: '#55555530', borderColor: '#555'}]} onPress={() => setFilter('none')}>
          <Text style={[styles.filterChipText, filter === 'none' && {color: '#aaa'}]}>None ({buzzes.filter(b => b.response === 'none').length})</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#FF4D4D" size="large" /></View>
      ) : buzzes.length === 0 ? (
        <View style={styles.center}>
          <Icon name="inbox" size={48} color="#888" style={{marginBottom: 12}} />
          <Text style={styles.emptyText}>No buzzes in the last 30 days</Text>
        </View>
      ) : (
        <FlatList
          data={filter === 'all' ? buzzes : buzzes.filter(b => b.response === filter)}
          renderItem={renderItem}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, {paddingBottom: insets.bottom + 24}]}
          showsVerticalScrollIndicator={false}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0D0D0D'},
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1A1A1A'},
  backButton: {paddingVertical: 4},
  backBtn: {color: '#FF4D4D', fontSize: 20, fontWeight: '700'},
  headerTitle: {color: '#fff', fontSize: 20, fontWeight: '800'},
  periodBadge: {backgroundColor: '#1A1A1A', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12},
  periodText: {color: '#888', fontSize: 12, fontWeight: '600'},
  filterBar: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1A1A1A'},
  filterChip: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: '#333', backgroundColor: '#1A1A1A'},
  filterChipActive: {backgroundColor: '#3a1515', borderColor: '#FF4D4D'},
  filterChipText: {color: '#888', fontSize: 12, fontWeight: '700'},
  filterChipTextActive: {color: '#FF4D4D'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyIcon: {fontSize: 48, marginBottom: 12},
  emptyText: {color: '#666', fontSize: 16},
  list: {paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24},
  card: {backgroundColor: '#1A1A1A', borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#252525'},
  cardHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10},
  avatarRow: {flexDirection: 'row', alignItems: 'center'},
  avatar: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#333', alignItems: 'center', justifyContent: 'center'},
  avatarText: {color: '#fff', fontSize: 14, fontWeight: '700'},
  arrow: {color: '#555', fontSize: 14, marginHorizontal: 6},
  namesCol: {marginLeft: 10},
  names: {color: '#fff', fontSize: 15, fontWeight: '700'},
  time: {color: '#666', fontSize: 12, marginTop: 1},
  escalatedBadge: {backgroundColor: '#FF980020', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6},
  escalatedText: {color: '#FF9800', fontSize: 10, fontWeight: '800', letterSpacing: 0.5},
  reasonRow: {marginBottom: 10},
  reason: {color: '#ccc', fontSize: 14},
  note: {color: '#888', fontSize: 13, fontStyle: 'italic', marginTop: 2},
  responseRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  responseBadge: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1},
  responseIcon: {fontSize: 14, fontWeight: '700', marginRight: 6},
  responseLabel: {fontSize: 13, fontWeight: '700'},
  responseTime: {color: '#666', fontSize: 12},
  footerLoader: {paddingVertical: 20, alignItems: 'center'},
});

export default HistoryScreen;
