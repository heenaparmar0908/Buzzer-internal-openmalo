import {Alert, Linking, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BATTERY_PROMPT_KEY = '@openmalo_battery_prompted';

export const promptBatteryOptimization = async () => {
  if (Platform.OS !== 'android') return;

  // Always try to request ignore battery optimizations
  try {
    await Linking.sendIntent(
      'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    );
  } catch {
    // If direct intent fails, show manual prompt
    const prompted = await AsyncStorage.getItem(BATTERY_PROMPT_KEY);
    if (prompted) return;

    Alert.alert(
      'Important: Allow Background Activity',
      'To receive buzzes when the app is closed, you must disable battery optimization for this app.\n\nGo to:\nSettings → Apps → OpenMalo Buzzer → Battery → Unrestricted',
      [
        {
          text: 'Open Settings',
          onPress: async () => {
            try {
              await Linking.openSettings();
            } catch {}
            await AsyncStorage.setItem(BATTERY_PROMPT_KEY, 'true');
          },
        },
        {
          text: 'Skip',
          style: 'cancel',
          onPress: async () => {
            await AsyncStorage.setItem(BATTERY_PROMPT_KEY, 'true');
          },
        },
      ],
    );
  }
};
