import {useState, useEffect} from 'react';
import {Group} from '../types';
import {subscribeToGroups} from '../services/firebase';

export const useGroups = () => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeToGroups(g => {
      setGroups(g);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return {groups, loading};
};
