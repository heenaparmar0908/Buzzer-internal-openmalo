import React, {useState, useEffect, useCallback, useRef} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialIcons';
import {Buzz} from '../types';
import {getBuzzLogPage, getUsers} from '../services/firebase';

interface Props {
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

const HistoryScreen: React.FC<Props> = ({onBack}) => {
  const insets = useSafeAreaInsets();
  const [buzzes, setBuzzes] = useState<Buzz[]>([]);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const lastDocRef = useRef<any>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [page, userList] = await Promise.all([
          getBuzzLogPage(),
          getUsers(),
        ]);
        setBuzzes(page.buzzes);
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
      setBuzzes(prev => [...prev, ...page.buzzes]);
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
    const fromName = usersMap[item.from_user_id] || '?';
    const toName = usersMap[item.to_user_id] || '?';
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
        <Text style={styles.headerTitle}>Buzz Log</Text>
        <View style={styles.periodBadge}>
          <Text style={styles.periodText}>30 days</Text>
        </View>
      </View>
      <View style={styles.stats}>
        <View style={styles.statItem}>
          <Text style={styles.statNumber}>{buzzes.length}</Text>
          <Text style={styles.statLabel}>Loaded</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, {color: '#4CAF50'}]}>{buzzes.filter(b => b.response === 'ack').length}</Text>
          <Text style={styles.statLabel}>Ack</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, {color: '#FF9800'}]}>{buzzes.filter(b => b.response === 'five_min').length}</Text>
          <Text style={styles.statLabel}>5 min</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, {color: '#F44336'}]}>{buzzes.filter(b => b.response === 'busy').length}</Text>
          <Text style={styles.statLabel}>Busy</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, {color: '#555'}]}>{buzzes.filter(b => b.response === 'none').length}</Text>
          <Text style={styles.statLabel}>None</Text>
        </View>
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
          data={buzzes}
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
  stats: {flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1A1A1A'},
  statItem: {alignItems: 'center'},
  statNumber: {color: '#fff', fontSize: 22, fontWeight: '800'},
  statLabel: {color: '#666', fontSize: 11, fontWeight: '600', marginTop: 2},
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
