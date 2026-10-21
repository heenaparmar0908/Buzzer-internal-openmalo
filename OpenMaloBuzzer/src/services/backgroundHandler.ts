import notifee, {
  EventType,
  AndroidImportance,
  AndroidVisibility,
} from '@notifee/react-native';
import {NOTIFICATION_CHANNEL_ID, SILENT_BUZZ_CHANNEL_ID, SILENT_BUZZ_CHANNEL_NAME, VOICEMAIL_CHANNEL_ID, VOICEMAIL_CHANNEL_NAME} from '../constants';

export const setupBackgroundHandler = () => {
  // Handle notification actions in background
  notifee.onBackgroundEvent(async ({type, detail}) => {
    if (type === EventType.ACTION_PRESS && detail.pressAction) {
      const buzzId = detail.notification?.data?.buzz_id as string;
      const actionId = detail.pressAction.id;
      if (buzzId && ['ack', 'five_min', 'busy'].includes(actionId)) {
        try {
          const {respondToBuzz} = require('./firebase');
          await respondToBuzz(buzzId, actionId as any);
        } catch (err) {
          console.warn('Background respond error:', err);
        }
        await notifee.cancelNotification(buzzId);
      }
    }
  });

  // Handle FCM background/killed messages
  try {
    const {getMessaging, setBackgroundMessageHandler} =
      require('@react-native-firebase/messaging');
    const messaging = getMessaging();
    setBackgroundMessageHandler(messaging, async (remoteMessage: any) => {
      const data = remoteMessage.data;
      if (!data) return;

      // Resolve sender name: use FCM data, or fetch from Firestore
      const resolveName = async (fromUserId: string, fromUserName?: string): Promise<string> => {
        if (fromUserName && fromUserName !== 'Someone') return fromUserName;
        if (!fromUserId) return 'User';
        try {
          const {getFirestore, doc, getDoc} = require('@react-native-firebase/firestore');
          const db = getFirestore();
          const snap = await getDoc(doc(db, 'users', fromUserId));
          if (snap.exists()) return snap.data()?.name || 'User';
        } catch {}
        return fromUserName || 'User';
      };

      if (data.type === 'buzz') {
        const senderName = await resolveName(data.from_user_id, data.from_user_name);

        await notifee.createChannel({
          id: SILENT_BUZZ_CHANNEL_ID,
          name: SILENT_BUZZ_CHANNEL_NAME,
          importance: AndroidImportance.HIGH,
          visibility: AndroidVisibility.PUBLIC,
          vibration: false,
          bypassDnd: true,
        });

        await notifee.displayNotification({
          id: data.buzz_id,
          title: `Buzz from ${senderName}`,
          body: data.reason + (data.note ? ` — ${data.note}` : ''),
          android: {
            channelId: SILENT_BUZZ_CHANNEL_ID,
            importance: AndroidImportance.HIGH,
            fullScreenAction: {
              id: 'incoming-buzz',
              launchActivity: 'default',
            },
            pressAction: {id: 'default'},
            actions: [
              {title: 'Ack', pressAction: {id: 'ack'}},
              {title: '5 min', pressAction: {id: 'five_min'}},
              {title: 'Busy', pressAction: {id: 'busy'}},
            ],
            category: 'buzz' as any,
            ongoing: true,
            autoCancel: false,
          },
          data: data as any,
        });
      }

      if (data.type === 'voice_message') {
        await notifee.createChannel({
          id: VOICEMAIL_CHANNEL_ID,
          name: VOICEMAIL_CHANNEL_NAME,
          importance: AndroidImportance.HIGH,
          visibility: AndroidVisibility.PUBLIC,
          sound: 'default',
          vibration: true,
        });

        const fromName = await resolveName(data.from_user_id, data.from_user_name);
        const duration = data.duration || '0';

        await notifee.displayNotification({
          title: `Voice message from ${fromName}`,
          body: `${duration}s voice message`,
          android: {
            channelId: VOICEMAIL_CHANNEL_ID,
            importance: AndroidImportance.HIGH,
            sound: 'default',
            pressAction: {id: 'default'},
            autoCancel: true,
          },
        });
      }

      if (data.type === 'buzz_cancelled') {
        const cancellerName = await resolveName(data.from_user_id, data.from_user_name);
        await notifee.cancelNotification(data.buzz_id);
        await notifee.displayNotification({
          title: 'Buzz cancelled',
          body: `${cancellerName} cancelled the buzz`,
          android: {
            channelId: NOTIFICATION_CHANNEL_ID,
            importance: AndroidImportance.DEFAULT,
            autoCancel: true,
            timeoutAfter: 10000,
            pressAction: {id: 'default'},
          },
        });
      }
    });
  } catch (err) {
    console.warn('FCM background handler setup error:', err);
  }
};
