import notifee, {
  EventType,
  AndroidImportance,
  AndroidVisibility,
} from '@notifee/react-native';
import {NOTIFICATION_CHANNEL_ID, NOTIFICATION_CHANNEL_NAME} from '../constants';

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

      if (data.type === 'buzz') {
        await notifee.createChannel({
          id: NOTIFICATION_CHANNEL_ID,
          name: NOTIFICATION_CHANNEL_NAME,
          importance: AndroidImportance.HIGH,
          visibility: AndroidVisibility.PUBLIC,
          sound: 'buzz_alarm',
          vibration: true,
          vibrationPattern: [0, 500, 200, 500, 200, 500],
          bypassDnd: true,
        });

        await notifee.displayNotification({
          id: data.buzz_id,
          title: `Buzz from ${data.from_user_name}`,
          body: data.reason + (data.note ? ` — ${data.note}` : ''),
          android: {
            channelId: NOTIFICATION_CHANNEL_ID,
            importance: AndroidImportance.HIGH,
            sound: 'buzz_alarm',
            vibrationPattern: [0, 500, 200, 500, 200, 500],
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
            loopSound: true,
            ongoing: true,
            autoCancel: false,
          },
          data: data as any,
        });
      }

      if (data.type === 'buzz_cancelled') {
        await notifee.cancelNotification(data.buzz_id);
        await notifee.displayNotification({
          title: 'Buzz cancelled',
          body: `${data.from_user_name || 'Sender'} cancelled the buzz`,
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
