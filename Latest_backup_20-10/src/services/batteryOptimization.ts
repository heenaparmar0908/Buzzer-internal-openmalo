import {Alert, Linking, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BATTERY_PROMPT_KEY = '@openmalo_battery_prompted';
const DND_PROMPT_KEY = '@openmalo_dnd_prompted';

export const promptBatteryOptimization = async () => {
  if (Platform.OS !== 'android') return;

  // Only prompt once
  const prompted = await AsyncStorage.getItem(BATTERY_PROMPT_KEY);
  if (prompted) return;

  await AsyncStorage.setItem(BATTERY_PROMPT_KEY, 'true');

  Alert.alert(
    'Important: Allow Background Activity',
    'To receive buzzes when the app is closed, you must disable battery optimization for this app.\n\nGo to:\nSettings → Apps → OpenMalo Buzzer → Battery → Unrestricted',
    [
      {
        text: 'Open Settings',
        onPress: () => {
          Linking.openSettings().catch(() => {});
        },
      },
      {
        text: 'Skip',
        style: 'cancel',
      },
    ],
  );
};

export const promptDndAccess = async () => {
  if (Platform.OS !== 'android') return;

  const prompted = await AsyncStorage.getItem(DND_PROMPT_KEY);
  if (prompted) return;

  await AsyncStorage.setItem(DND_PROMPT_KEY, 'true');

  Alert.alert(
    'Allow Do Not Disturb Access',
    'Buzzer needs DND access to ring loud even when your phone is on silent or Do Not Disturb mode.',
    [
      {
        text: 'Allow',
        onPress: () => {
          try {
            Linking.sendIntent('android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS').catch(() => {
              Linking.openSettings().catch(() => {});
            });
          } catch {
            Linking.openSettings().catch(() => {});
          }
        },
      },
      {
        text: 'Skip',
        style: 'cancel',
      },
    ],
  );
};
