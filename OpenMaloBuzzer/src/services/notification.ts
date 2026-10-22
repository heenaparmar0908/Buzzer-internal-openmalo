import notifee, {
  AndroidImportance,
  AndroidVisibility,
  EventType,
} from '@notifee/react-native';
import {NOTIFICATION_CHANNEL_ID, NOTIFICATION_CHANNEL_NAME, SILENT_BUZZ_CHANNEL_ID, SILENT_BUZZ_CHANNEL_NAME, VOICEMAIL_CHANNEL_ID, VOICEMAIL_CHANNEL_NAME} from '../constants';
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
  // Silent channel — used by notifee notifications (native service handles sound)
  await notifee.createChannel({
    id: SILENT_BUZZ_CHANNEL_ID,
    name: SILENT_BUZZ_CHANNEL_NAME,
    importance: AndroidImportance.HIGH,
    visibility: AndroidVisibility.PUBLIC,
    vibration: false,
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

export const showBuzzNotification = async (payload: BuzzPayload) => {
  await notifee.displayNotification({
    id: payload.buzz_id,
    title: `Buzz from ${payload.from_user_name}`,
    body: payload.reason + (payload.note && payload.note !== 'null' ? ` — ${payload.note}` : ''),
    android: {
      channelId: SILENT_BUZZ_CHANNEL_ID,
      importance: AndroidImportance.HIGH,
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
      ongoing: true,
      autoCancel: false,
    },
    data: payload as any,
  });
};

export const showVoiceMailNotification = async (
  fromUserName: string,
  duration: number,
) => {
  await notifee.displayNotification({
    title: `Voice message from ${fromUserName}`,
    body: `${duration}s voice message`,
    android: {
      channelId: VOICEMAIL_CHANNEL_ID,
      importance: AndroidImportance.HIGH,
      sound: 'default',
      pressAction: {id: 'default'},
      autoCancel: true,
    },
    ios: {
      sound: 'default',
    },
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
