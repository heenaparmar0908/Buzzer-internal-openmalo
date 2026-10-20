import {useState, useEffect} from 'react';
import {Reason} from '../types';
import {subscribeToReasons} from '../services/firebase';

export const useReasons = () => {
  const [reasons, setReasons] = useState<Reason[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToReasons(setReasons);
    return unsubscribe;
  }, []);

  return reasons;
};
