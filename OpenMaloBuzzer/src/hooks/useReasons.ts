import {useState, useEffect} from 'react';
import {Reason} from '../types';
import {subscribeToReasons} from '../services/firebase';

let cachedReasons: Reason[] | null = null;

export const useReasons = () => {
  const [reasons, setReasons] = useState<Reason[]>(cachedReasons || []);

  useEffect(() => {
    const unsubscribe = subscribeToReasons(data => {
      cachedReasons = data;
      setReasons(data);
    });
    return unsubscribe;
  }, []);

  return reasons;
};
