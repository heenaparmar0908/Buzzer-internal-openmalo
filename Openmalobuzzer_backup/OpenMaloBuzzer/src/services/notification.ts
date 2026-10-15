import notifee, {
  AndroidImportance,
  AndroidVisibility,
  EventType,
} from '@notifee/react-native';
import {NOTIFICATION_CHANNEL_ID, NOTIFICATION_CHANNEL_NAME} from '../constants';
import {BuzzPayload} from '../types';

export const createNotificationChannel = async () => {
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
};

export const showBuzzNotification = async (payload: BuzzPayload) => {
  await notifee.displayNotification({
    id: payload.buzz_id,
    title: `Buzz from ${payload.from_user_name}`,
    body: payload.reason + (payload.note ? ` — ${payload.note}` : ''),
    android: {
      channelId: NOTIFICATION_CHANNEL_ID,
      importance: AndroidImportance.HIGH,
      sound: 'buzz_alarm',
      vibrationPattern: [0, 500, 200, 500, 200, 500],
      fullScreenAction: {
        id: 'incoming-buzz',
        launchActivity: 'default',
      },
      pressAction: {
        id: 'default',
      },
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
    data: payload as any,
  });
};

export const cancelBuzzNotification = async (buzzId: string) => {
  await notifee.cancelNotification(buzzId);
};

export const setupNotificationListeners = (
  onResponse: (buzzId: string, response: string) => void,
  onOpen: (payload: BuzzPayload) => void,
) => {
  return notifee.onForegroundEvent(({type, detail}) => {
    if (type === EventType.ACTION_PRESS && detail.pressAction) {
      const buzzId = detail.notification?.data?.buzz_id as string;
      const actionId = detail.pressAction.id;
      if (buzzId && ['ack', 'five_min', 'busy'].includes(actionId)) {
        onResponse(buzzId, actionId);
        notifee.cancelNotification(buzzId);
      }
    }
    if (type === EventType.PRESS && detail.notification?.data) {
      onOpen(detail.notification.data as unknown as BuzzPayload);
    }
  });
};
