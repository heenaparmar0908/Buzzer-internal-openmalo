/**
 * Tests for batteryOptimization.ts — covers promptBatteryOptimization,
 * checkAndPromptBattery, and promptDndAccess across platforms and states.
 *
 * batteryOptimization.ts captures BuzzerService at module load time:
 *   const {BuzzerService} = NativeModules;
 * So NativeModules.BuzzerService must be set BEFORE the module is required.
 * We use jest.resetModules() + dynamic require() to get a fresh module each test.
 * After resetModules, we also re-require dependencies to get the same instances
 * the freshly loaded module uses.
 */

jest.mock('../src/services/supabase', () => ({
  supabase: {from: jest.fn()},
  VOICE_MAIL_BUCKET: 'voice-mails',
  uploadVoiceMail: jest.fn(),
}));
jest.mock('@env', () => ({SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'test-key'}));
jest.mock('react-native-url-polyfill/auto', () => {});

import {Platform, NativeModules, Alert} from 'react-native';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  NativeModules.BuzzerService = undefined;
  (Platform as any).OS = 'android';
});

/** Helper: get the same Alert instance the freshly required module will use. */
function getAlert() {
  return require('react-native').Alert;
}

/** Helper: get the same AsyncStorage instance the freshly required module will use. */
function getAsyncStorage() {
  const AS = require('@react-native-async-storage/async-storage').default;
  AS.getItem.mockResolvedValue(null);
  AS.setItem.mockResolvedValue(undefined);
  return AS;
}

describe('promptBatteryOptimization', () => {
  it('does nothing on iOS', async () => {
    (Platform as any).OS = 'ios';
    const AS = getAsyncStorage();
    const alert = getAlert();
    const alertSpy = jest.spyOn(alert, 'alert').mockImplementation(() => {});
    const {promptBatteryOptimization} = require('../src/services/batteryOptimization');
    await promptBatteryOptimization();
    expect(AS.getItem).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('skips if already prompted', async () => {
    const AS = getAsyncStorage();
    AS.getItem.mockResolvedValue('true');
    const alert = getAlert();
    const alertSpy = jest.spyOn(alert, 'alert').mockImplementation(() => {});
    const {promptBatteryOptimization} = require('../src/services/batteryOptimization');
    await promptBatteryOptimization();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('marks as prompted in AsyncStorage', async () => {
    const AS = getAsyncStorage();
    const {promptBatteryOptimization} = require('../src/services/batteryOptimization');
    await promptBatteryOptimization();
    expect(AS.setItem).toHaveBeenCalledWith('@buzzer_battery_prompted', 'true');
  });

  it('shows generic prompt when native module unavailable', async () => {
    getAsyncStorage();
    const alert = getAlert();
    const alertSpy = jest.spyOn(alert, 'alert').mockImplementation(() => {});
    const {promptBatteryOptimization} = require('../src/services/batteryOptimization');
    await promptBatteryOptimization();
    expect(alertSpy).toHaveBeenCalledWith(
      'Important: Allow Background Activity',
      expect.stringContaining('battery optimization'),
      expect.any(Array),
    );
    alertSpy.mockRestore();
  });
});

describe('checkAndPromptBattery', () => {
  it('returns null on iOS', async () => {
    (Platform as any).OS = 'ios';
    const {checkAndPromptBattery} = require('../src/services/batteryOptimization');
    const result = await checkAndPromptBattery();
    expect(result).toBeNull();
  });

  it('returns null when native module unavailable', async () => {
    const {checkAndPromptBattery} = require('../src/services/batteryOptimization');
    const result = await checkAndPromptBattery();
    expect(result).toBeNull();
  });
});

describe('promptDndAccess', () => {
  it('does nothing on iOS', async () => {
    (Platform as any).OS = 'ios';
    const alert = getAlert();
    const alertSpy = jest.spyOn(alert, 'alert').mockImplementation(() => {});
    const {promptDndAccess} = require('../src/services/batteryOptimization');
    await promptDndAccess();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('skips if DND access already granted', async () => {
    NativeModules.BuzzerService = {
      isDndAccessGranted: jest.fn().mockResolvedValue(true),
    };
    const alert = getAlert();
    const alertSpy = jest.spyOn(alert, 'alert').mockImplementation(() => {});
    const {promptDndAccess} = require('../src/services/batteryOptimization');
    await promptDndAccess();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('shows DND access prompt when not granted (Android)', async () => {
    NativeModules.BuzzerService = {
      isDndAccessGranted: jest.fn().mockResolvedValue(false),
    };
    const alert = getAlert();
    const alertSpy = jest.spyOn(alert, 'alert').mockImplementation(() => {});
    const {promptDndAccess} = require('../src/services/batteryOptimization');
    await promptDndAccess();
    expect(alertSpy).toHaveBeenCalledWith(
      'Allow Do Not Disturb Access',
      expect.stringContaining('DND'),
      expect.any(Array),
    );
    alertSpy.mockRestore();
  });
});
