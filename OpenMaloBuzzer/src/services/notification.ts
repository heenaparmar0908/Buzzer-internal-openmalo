import notifee, {
  AndroidImportance,
  AndroidVisibility,
  EventType,
} from '@notifee/react-native';
import {NOTIFICATION_CHANNEL_ID, NOTIFICATION_CHANNEL_NAME, VOICEMAIL_CHANNEL_ID, VOICEMAIL_CHANNEL_NAME} from '../constants';
import {BuzzPayload} from '../types';

export const createNotificationChannel = async () => {
  // Sound channel — used only by native BuzzerService alarm
  await notifee.createChannel({
    id: NOTIFICATION_CHANNEL_ID,
    name: NOTIFICATION_CHANNEL_NAME,
    importance: AndroidImportance.HIGH,
    visibility: AndroidVisibility.PUBLIC,
    sound: 'buzz_alarm',
    vibration: true,
    vibrationPattern: [300, 500, 200, 500],
    bypassDnd: true,
  });
  await notifee.createChannel({
    id: VOICEMAIL_CHANNEL_ID,
    name: VOICEMAIL_CHANNEL_NAME,
    importance: AndroidImportance.HIGH,
    visibility: AndroidVisibility.PUBLIC,
    sound: 'default',
    vibration: true,
  });
};

export const cancelBuzzNotification = async (buzzId: string) => {
  await notifee.cancelNotification(buzzId);
};

export const setupNotificationListeners = (
  onResponse: (buzzId: string, response: string) => void,
  onOpen: (payload: BuzzPayload) => void,
  onOpenVoiceMail?: () => void,
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
      const data = detail.notification.data;
      if (data.type === 'voice_message' && onOpenVoiceMail) {
        onOpenVoiceMail();
      } else if (data.buzz_id) {
        onOpen(data as unknown as BuzzPayload);
      }
    }
  });
};
