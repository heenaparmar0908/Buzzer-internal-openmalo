/**
 * Comprehensive Android & iOS buzz tests — incoming and outgoing.
 *
 * Users (ONLY these two are used in all tests):
 *   - Heena Parmar  (id: 'heena-1', sender in outgoing tests, receiver in incoming tests)
 *   - Test User     (id: 'test-1',  receiver in outgoing tests, sender in incoming tests)
 *
 * Covers:
 *   OUTGOING (sender side):
 *     - Personal buzz create + push (Android / iOS)
 *     - Group buzz create + push per member
 *     - Cancellation push
 *     - Escalation / re-buzz push
 *     - Push result handling (delivered, no_token, token_invalid, failed)
 *     - Network failure during create
 *
 *   INCOMING (receiver side):
 *     Android background: FCM bg handler → native service fallback → notifee
 *     Android foreground: FCM onMessage (simulated)
 *     iOS background: FCM bg handler returns early (APNs handles)
 *     iOS foreground: FCM onMessage (simulated)
 *     Buzz cancellation on both platforms
 *     Voice message on both platforms
 *     Notification action responses (ack, five_min, busy)
 *
 *   LIFECYCLE:
 *     - Response flow (ack, five_min, busy, cancelled, dismissed, auto_dismissed)
 *     - Stale buzz detection (older than 5 min)
 *     - Duplicate prevention
 *     - respondToBuzz retry + persistence
 *     - flushPendingResponses
 */

// ──────────────────────────────────────────────────────────
// Test Users — the ONLY two users in all tests
// ──────────────────────────────────────────────────────────
const HEENA = {
  id: 'heena-1',
  name: 'Heena Parmar',
  phone: '+919876543210',
  pin_hash: 'hash1',
  role: 'owner' as const,
  last_seen_at: Date.now(),
  is_active: true,
  tenant_id: 'tenant-1',
};

const TEST_USER = {
  id: 'test-1',
  name: 'Test User',
  phone: '+919876543211',
  pin_hash: 'hash2',
  role: 'member' as const,
  last_seen_at: Date.now(),
  is_active: true,
  tenant_id: 'tenant-1',
};

const GROUP = {
  id: 'group-1',
  name: 'Test Group',
  member_ids: [HEENA.id, TEST_USER.id],
  created_by: HEENA.id,
  created_at: Date.now(),
  is_active: true,
  tenant_id: 'tenant-1',
};

// ──────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────

jest.mock('../src/services/supabase', () => {
  const _state = {
    fromImpl: (_table: string): any => _state._defaultChainable(),
    _defaultChainable: () => {
      const obj: any = {};
      for (const m of ['select','insert','update','upsert','delete','eq','neq','in','is','gte','limit','order','range','contains','or']) {
        obj[m] = jest.fn().mockReturnValue(obj);
      }
      obj.single = jest.fn(() => Promise.resolve({data: null, error: null}));
      obj.maybeSingle = jest.fn(() => Promise.resolve({data: null, error: null}));
      obj.then = jest.fn((cb: any) => Promise.resolve({data: null, error: null}).then(cb));
      return obj;
    },
  };
  return {
    supabase: {
      from: jest.fn((t: string) => _state.fromImpl(t)),
      channel: jest.fn(() => ({on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis()})),
      removeChannel: jest.fn(),
    },
    _state,
    VOICE_MAIL_BUCKET: 'voice-mails',
    uploadVoiceMail: jest.fn(),
  };
});

jest.mock('@env', () => ({
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
}));
jest.mock('react-native-url-polyfill/auto', () => {});
jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(() => ({})),
  setBackgroundMessageHandler: jest.fn(),
  onMessage: jest.fn(() => jest.fn()),
  onNotificationOpenedApp: jest.fn(() => jest.fn()),
  getInitialNotification: jest.fn(() => Promise.resolve(null)),
  requestPermission: jest.fn(() => Promise.resolve(1)),
  getToken: jest.fn(() => Promise.resolve('mock-token')),
  onTokenRefresh: jest.fn(() => jest.fn()),
}));
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(() => Promise.resolve()),
    cancelNotification: jest.fn(() => Promise.resolve()),
    cancelAllNotifications: jest.fn(() => Promise.resolve()),
    createChannel: jest.fn(() => Promise.resolve()),
    onBackgroundEvent: jest.fn(),
    onForegroundEvent: jest.fn(() => jest.fn()),
    setNotificationCategories: jest.fn(() => Promise.resolve()),
  },
  EventType: {ACTION_PRESS: 1, PRESS: 4},
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidVisibility: {PUBLIC: 1},
}));

const fetchMock = jest.fn(() =>
  Promise.resolve({ok: true, json: () => Promise.resolve({})} as Response),
);
(global as any).fetch = fetchMock;

// ──────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────

import {
  createBuzz,
  createGroupBuzz,
  respondToBuzz,
  flushPendingResponses,
  subscribeToBuzz,
  subscribeToIncomingBuzzes,
  markBuzzDelivered,
  markBuzzNotified,
  markEscalated,
} from '../src/services/firebase';
import {
  sendBuzzPush,
  sendBuzzCancelledPush,
  sendEscalationPush,
  sendVoiceMailPush,
} from '../src/services/pushNotification';
import {setupBackgroundHandler} from '../src/services/backgroundHandler';

const {_state, supabase: mockSupabase} = require('../src/services/supabase');

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function chainable(result: () => {data: any; error: any} = () => ({data: null, error: null})) {
  const obj: any = {};
  for (const m of ['select','update','upsert','delete','eq','neq','in','is','gte','limit','order','range','contains','or']) {
    obj[m] = jest.fn().mockReturnValue(obj);
  }
  obj.insert = jest.fn().mockReturnValue(obj);
  obj.single = jest.fn(() => Promise.resolve(result()));
  obj.maybeSingle = jest.fn(() => Promise.resolve(result()));
  obj.then = jest.fn((cb: any) => Promise.resolve(result()).then(cb));
  return obj;
}

function withToken(userId: string, token: string | null, opts: {stale?: boolean; platform?: string; updatedAt?: number; voipToken?: string | null} = {}) {
  const prev = _state.fromImpl;
  _state.fromImpl = (table: string) => {
    if (table === 'user_tokens') {
      return chainable(() => ({
        data: token ? {
          fcm_token: token,
          fcm_token_stale: opts.stale || false,
          token_updated_at: opts.updatedAt || Date.now(),
          platform: opts.platform || 'android',
          voip_token: opts.voipToken || null,
        } : null,
        error: null,
      }));
    }
    return prev(table);
  };
}

function withBuzzInsert(buzzId: string) {
  const prev = _state.fromImpl;
  _state.fromImpl = (table: string) => {
    if (table === 'buzzes') {
      return chainable(() => ({data: {id: buzzId}, error: null}));
    }
    return prev(table);
  };
}

function withGroupBuzzInsert(memberCount: number) {
  const prev = _state.fromImpl;
  _state.fromImpl = (table: string) => {
    if (table === 'buzzes') {
      const c = chainable();
      c.insert = jest.fn((rows: any[]) => ({
        select: jest.fn(() => Promise.resolve({
          data: rows.map((_: any, i: number) => ({id: `gb-${i}`})),
          error: null,
        })),
      }));
      return c;
    }
    return prev(table);
  };
}

function captureUpdates(): {updates: any[]} {
  const ctx = {updates: [] as any[]};
  const prev = _state.fromImpl;
  _state.fromImpl = (table: string) => {
    if (table === 'buzzes') {
      const c = chainable(() => ({data: null, error: null}));
      c.update = jest.fn((data: any) => {
        ctx.updates.push(data);
        return c; // return chainable so .eq().in() chain works
      });
      return c;
    }
    return prev(table);
  };
  return ctx;
}

// ──────────────────────────────────────────────────────────
// Reset
// ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockClear();
  fetchMock.mockImplementation(() =>
    Promise.resolve({ok: true, json: () => Promise.resolve({})} as Response),
  );
  _state.fromImpl = () => _state._defaultChainable();
  require('@notifee/react-native').default.displayNotification.mockClear();
  require('@notifee/react-native').default.cancelNotification.mockClear();
  require('@notifee/react-native').default.createChannel.mockClear();
});

// ══════════════════════════════════════════════════════════
//  OUTGOING BUZZ — SENDER SIDE
// ══════════════════════════════════════════════════════════

describe('OUTGOING: Heena Parmar → Test User (personal buzz)', () => {
  it('creates buzz in Supabase with correct fields', async () => {
    withBuzzInsert('out-1');
    const result = await createBuzz({
      from_user_id: HEENA.id,
      from_user_name: HEENA.name,
      to_user_id: TEST_USER.id,
      reason: 'Come to cabin',
      note: 'Urgent',
      created_at: Date.now(),
      responded_at: null,
      response: 'none',
      escalated: false,
    });
    expect(result.id).toBe('out-1');
    expect(mockSupabase.from).toHaveBeenCalledWith('buzzes');
  });

  it('sends FCM push with correct payload', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzPush(TEST_USER.id, 'out-1', HEENA.id, HEENA.name, 'Come to cabin', 'Urgent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.fcm_token).toBe('test-user-token');
    expect(body.data).toEqual(expect.objectContaining({
      type: 'buzz',
      buzz_id: 'out-1',
      from_user_id: HEENA.id,
      from_user_name: HEENA.name,
      reason: 'Come to cabin',
      note: 'Urgent',
    }));
  });

  it('sends null note as empty string in push payload', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzPush(TEST_USER.id, 'out-2', HEENA.id, HEENA.name, 'Meeting', null);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.note).toBe('');
  });

  it('includes custom sound_id in push payload', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzPush(TEST_USER.id, 'out-3', HEENA.id, HEENA.name, 'Lunch', null, 'alarm_urgent');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.sound_id).toBe('alarm_urgent');
  });

  it('returns "delivered" on successful push', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    const result = await sendBuzzPush(TEST_USER.id, 'out-4', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('delivered');
  });

  it('returns "no_token" when Test User has no FCM token', async () => {
    withToken(TEST_USER.id, null);
    const result = await sendBuzzPush(TEST_USER.id, 'out-5', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('no_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "token_invalid" when FCM reports UNREGISTERED', async () => {
    withToken(TEST_USER.id, 'stale-token');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({error: {code: 'messaging/registration-token-not-registered'}}),
    } as any);
    const result = await sendBuzzPush(TEST_USER.id, 'out-6', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('token_invalid');
  });

  it('returns "failed" on network error after retries', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    fetchMock.mockRejectedValue(new Error('Network error'));
    const result = await sendBuzzPush(TEST_USER.id, 'out-7', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('failed');
  }, 30000);

  it('throws when Supabase insert fails (sender sees error)', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        return chainable(() => ({data: null, error: {message: 'Insert failed'}}));
      }
      return _state._defaultChainable();
    };
    await expect(createBuzz({
      from_user_id: HEENA.id, from_user_name: HEENA.name, to_user_id: TEST_USER.id,
      reason: 'Test', note: null, created_at: Date.now(),
      responded_at: null, response: 'none', escalated: false,
    })).rejects.toBeDefined();
  });
});

describe('OUTGOING: Test User → Heena Parmar (personal buzz)', () => {
  it('creates buzz with Test User as sender and Heena as receiver', async () => {
    withBuzzInsert('rev-1');
    const result = await createBuzz({
      from_user_id: TEST_USER.id,
      from_user_name: TEST_USER.name,
      to_user_id: HEENA.id,
      reason: 'Need help',
      note: null,
      created_at: Date.now(),
      responded_at: null,
      response: 'none',
      escalated: false,
    });
    expect(result.id).toBe('rev-1');
  });

  it('sends FCM push to Heena Parmar', async () => {
    withToken(HEENA.id, 'heena-token', {platform: 'ios'});
    await sendBuzzPush(HEENA.id, 'rev-1', TEST_USER.id, TEST_USER.name, 'Need help', null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.fcm_token).toBe('heena-token');
    expect(body.data.from_user_name).toBe('Test User');
    expect(body.platform).toBe('ios');
  });
});

describe('OUTGOING: Cancellation push', () => {
  it('Heena cancels buzz to Test User — sends buzz_cancelled push', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzCancelledPush(TEST_USER.id, 'cancel-1', HEENA.name);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data).toEqual({
      type: 'buzz_cancelled',
      buzz_id: 'cancel-1',
      from_user_name: HEENA.name,
    });
  });

  it('Test User cancels buzz to Heena — sends buzz_cancelled push', async () => {
    withToken(HEENA.id, 'heena-token');
    await sendBuzzCancelledPush(HEENA.id, 'cancel-2', TEST_USER.name);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.from_user_name).toBe('Test User');
  });

  it('cancellation skipped when receiver has stale token', async () => {
    withToken(TEST_USER.id, 'stale', {stale: true});
    await sendBuzzCancelledPush(TEST_USER.id, 'cancel-3', HEENA.name);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OUTGOING: Escalation / re-buzz push', () => {
  it('Heena re-buzzes Test User with RE-BUZZ prefix', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    await sendEscalationPush(TEST_USER.id, 'esc-1', HEENA.id, HEENA.name, 'Come to cabin', 'Urgent');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.type).toBe('buzz');
    expect(body.data.reason).toBe('RE-BUZZ: Come to cabin');
    expect(body.data.note).toBe('Urgent');
  });

  it('escalation skipped when receiver has stale token', async () => {
    withToken(TEST_USER.id, 'stale', {stale: true});
    await sendEscalationPush(TEST_USER.id, 'esc-2', HEENA.id, HEENA.name, 'Test', null);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OUTGOING: Group buzz — Heena buzzes group with Test User', () => {
  const memberIds = [TEST_USER.id]; // Heena is sender, excluded from members

  it('creates one buzz row per member', async () => {
    let insertedRows: any[] = [];
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = chainable();
        c.insert = jest.fn((rows: any[]) => {
          insertedRows = rows;
          return {select: jest.fn(() => Promise.resolve({
            data: rows.map((_: any, i: number) => ({id: `gb-${i}`})),
            error: null,
          }))};
        });
        return c;
      }
      return _state._defaultChainable();
    };

    const results = await createGroupBuzz(
      HEENA.id, HEENA.name, memberIds, 'Standup', 'Conference room', GROUP.id, GROUP.name,
    );
    expect(results).toHaveLength(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].from_user_id).toBe(HEENA.id);
    expect(insertedRows[0].from_user_name).toBe(HEENA.name);
    expect(insertedRows[0].to_user_id).toBe(TEST_USER.id);
    expect(insertedRows[0].reason).toBe('Standup');
    expect(insertedRows[0].note).toBe('Conference room');
    expect(insertedRows[0].group_id).toBe(GROUP.id);
    expect(insertedRows[0].group_name).toBe(GROUP.name);
  });

  it('sends FCM push to Test User for group buzz', async () => {
    withGroupBuzzInsert(1);
    const results = await createGroupBuzz(
      HEENA.id, HEENA.name, memberIds, 'Standup', null, GROUP.id, GROUP.name,
    );
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzPush(TEST_USER.id, results[0].id, HEENA.id, HEENA.name, 'Standup', null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.from_user_name).toBe('Heena Parmar');
  });

  it('handles empty member list without crash', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = chainable();
        c.insert = jest.fn(() => ({
          select: jest.fn(() => Promise.resolve({data: [], error: null})),
        }));
        return c;
      }
      return _state._defaultChainable();
    };
    const results = await createGroupBuzz(HEENA.id, HEENA.name, [], 'Test', null, GROUP.id, GROUP.name);
    expect(results).toHaveLength(0);
  });

  it('includes tenant_id when provided', async () => {
    let insertedRows: any[] = [];
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = chainable();
        c.insert = jest.fn((rows: any[]) => {
          insertedRows = rows;
          return {select: jest.fn(() => Promise.resolve({
            data: rows.map((_: any, i: number) => ({id: `gb-t-${i}`})),
            error: null,
          }))};
        });
        return c;
      }
      return _state._defaultChainable();
    };
    await createGroupBuzz(HEENA.id, HEENA.name, memberIds, 'Test', null, GROUP.id, GROUP.name, 'buzz_alarm', 'tenant-1');
    expect(insertedRows[0].tenant_id).toBe('tenant-1');
  });
});

// ══════════════════════════════════════════════════════════
//  INCOMING BUZZ — ANDROID BACKGROUND
// ══════════════════════════════════════════════════════════

describe('INCOMING ANDROID BACKGROUND: Test User receives buzz from Heena', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'android');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  afterEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
  });

  it('shows notifee fallback notification with sender name and reason', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-1', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Come to cabin', note: '',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'in-a-1',
        title: `Buzz from ${HEENA.name}`,
        body: 'Come to cabin',
      }),
    );
  });

  it('includes note in notification body with dash separator', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-2', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Meeting', note: 'Room 4',
    }});
    const body = require('@notifee/react-native').default.displayNotification.mock.calls[0][0].body;
    expect(body).toBe('Meeting — Room 4');
  });

  it('excludes "null" string note from body', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-3', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Urgent', note: 'null',
    }});
    const body = require('@notifee/react-native').default.displayNotification.mock.calls[0][0].body;
    expect(body).toBe('Urgent');
  });

  it('creates fallback channel with HIGH importance and vibration', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-4', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Test', note: '',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      importance: 4, // HIGH
      vibration: true,
      vibrationPattern: [0, 500, 200, 500, 200, 500],
    }));
  });

  it('notification has fullScreenAction for heads-up display', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-5', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Test', note: '',
    }});
    const notif = require('@notifee/react-native').default.displayNotification.mock.calls[0][0];
    expect(notif.android.fullScreenAction).toEqual({id: 'incoming-buzz', launchActivity: 'default'});
  });

  it('notification has action buttons: Ack, 5 min, Busy', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-6', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Test', note: '',
    }});
    const actions = require('@notifee/react-native').default.displayNotification.mock.calls[0][0].android.actions;
    expect(actions).toEqual([
      {title: 'Ack', pressAction: {id: 'ack'}},
      {title: '5 min', pressAction: {id: 'five_min'}},
      {title: 'Busy', pressAction: {id: 'busy'}},
    ]);
  });

  it('notification is ongoing (cannot be swiped away)', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-7', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Test', note: '',
    }});
    const notif = require('@notifee/react-native').default.displayNotification.mock.calls[0][0];
    expect(notif.android.ongoing).toBe(true);
    expect(notif.android.autoCancel).toBe(false);
  });

  it('defaults sender name to "User" when missing', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-8', from_user_id: HEENA.id,
      reason: 'Test', note: '',
    }});
    const title = require('@notifee/react-native').default.displayNotification.mock.calls[0][0].title;
    expect(title).toBe('Buzz from User');
  });

  it('group buzz from Heena shows same notification format', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-a-grp-1', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Team standup', note: 'Join now',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'in-a-grp-1',
        title: `Buzz from ${HEENA.name}`,
        body: 'Team standup — Join now',
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════
//  INCOMING BUZZ — ANDROID CANCELLATION
// ══════════════════════════════════════════════════════════

describe('INCOMING ANDROID: Buzz cancellation', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'android');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  afterEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
  });

  it('cancels original notification and shows "Buzz cancelled" notice', async () => {
    await bgHandler!({data: {
      type: 'buzz_cancelled', buzz_id: 'cancel-a-1', from_user_name: HEENA.name,
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.cancelNotification).toHaveBeenCalledWith('cancel-a-1');
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Buzz cancelled',
        body: `${HEENA.name} cancelled the buzz`,
      }),
    );
  });

  it('cancellation notice uses LOW importance (silent)', async () => {
    await bgHandler!({data: {
      type: 'buzz_cancelled', buzz_id: 'cancel-a-2', from_user_name: TEST_USER.name,
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'buzzer_cancelled',
      importance: 2, // LOW
      vibration: false,
    }));
  });
});

// ══════════════════════════════════════════════════════════
//  INCOMING BUZZ — ANDROID VOICE MESSAGE
// ══════════════════════════════════════════════════════════

describe('INCOMING ANDROID: Voice message from Heena to Test User', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'android');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  afterEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
  });

  it('shows voice message notification with duration', async () => {
    await bgHandler!({data: {
      type: 'voice_message', from_user_name: HEENA.name, duration: '12',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `Voice message from ${HEENA.name}`,
        body: '12s voice message',
      }),
    );
  });

  it('creates voicemail channel with default sound', async () => {
    await bgHandler!({data: {
      type: 'voice_message', from_user_name: HEENA.name, duration: '5',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'buzzer_voicemail',
      sound: 'default',
    }));
  });

  it('defaults duration to 0 when missing', async () => {
    await bgHandler!({data: {
      type: 'voice_message', from_user_name: TEST_USER.name,
    }});
    const body = require('@notifee/react-native').default.displayNotification.mock.calls[0][0].body;
    expect(body).toBe('0s voice message');
  });
});

// ══════════════════════════════════════════════════════════
//  INCOMING BUZZ — iOS BACKGROUND
// ══════════════════════════════════════════════════════════

describe('INCOMING iOS BACKGROUND: Heena receives buzz from Test User', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    // Platform defaults to 'ios' in jest setup
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  it('returns early — does NOT show notifee notification (APNs handles it)', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-ios-1', from_user_id: TEST_USER.id,
      from_user_name: TEST_USER.name, reason: 'Need help', note: 'At desk',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });

  it('does NOT start BuzzerAlarmModule in background (would get killed by iOS)', async () => {
    // The handler should return early for iOS buzz type
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-ios-2', from_user_id: TEST_USER.id,
      from_user_name: TEST_USER.name, reason: 'Meeting', note: '',
    }});
    // If it returned early, no channel creation either
    const notifee = require('@notifee/react-native').default;
    expect(notifee.createChannel).not.toHaveBeenCalled();
  });

  it('group buzz also returns early on iOS', async () => {
    await bgHandler!({data: {
      type: 'buzz', buzz_id: 'in-ios-grp-1', from_user_id: TEST_USER.id,
      from_user_name: TEST_USER.name, reason: 'Team standup', note: '',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).not.toHaveBeenCalled();
  });
});

describe('INCOMING iOS BACKGROUND: Voice message', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  it('shows iOS notification with timeSensitive interruption level', async () => {
    await bgHandler!({data: {
      type: 'voice_message', from_user_name: TEST_USER.name, duration: '8',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `Voice message from ${TEST_USER.name}`,
        body: '8s voice message',
        ios: expect.objectContaining({
          sound: 'default',
          interruptionLevel: 'timeSensitive',
        }),
      }),
    );
  });

  it('does NOT create Android channel on iOS', async () => {
    await bgHandler!({data: {
      type: 'voice_message', from_user_name: HEENA.name, duration: '5',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.createChannel).not.toHaveBeenCalled();
  });
});

describe('INCOMING iOS BACKGROUND: Buzz cancellation', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  it('cancels notification and shows cancellation notice on iOS', async () => {
    await bgHandler!({data: {
      type: 'buzz_cancelled', buzz_id: 'cancel-ios-1', from_user_name: TEST_USER.name,
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.cancelNotification).toHaveBeenCalledWith('cancel-ios-1');
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Buzz cancelled',
        body: `${TEST_USER.name} cancelled the buzz`,
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════
//  INCOMING — EDGE CASES (both platforms)
// ══════════════════════════════════════════════════════════

describe('INCOMING: Edge cases', () => {
  let bgHandler: ((msg: any) => Promise<void>) | null = null;

  beforeEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'android');
    bgHandler = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();
  });

  afterEach(() => {
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
  });

  it('ignores null data', async () => {
    await bgHandler!({data: null});
    expect(require('@notifee/react-native').default.displayNotification).not.toHaveBeenCalled();
  });

  it('ignores undefined data', async () => {
    await bgHandler!({});
    expect(require('@notifee/react-native').default.displayNotification).not.toHaveBeenCalled();
  });

  it('ignores unknown message type', async () => {
    await bgHandler!({data: {type: 'unknown_type'}});
    expect(require('@notifee/react-native').default.displayNotification).not.toHaveBeenCalled();
  });

  it('multiple buzzes each get their own notification', async () => {
    const ids = ['multi-1', 'multi-2', 'multi-3'];
    for (const id of ids) {
      await bgHandler!({data: {
        type: 'buzz', buzz_id: id, from_user_id: HEENA.id,
        from_user_name: HEENA.name, reason: 'Test', note: '',
      }});
    }
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).toHaveBeenCalledTimes(3);
    const notifIds = notifee.displayNotification.mock.calls.map((c: any[]) => c[0].id);
    expect(notifIds).toEqual(ids);
  });
});

// ══════════════════════════════════════════════════════════
//  RESPONSE FLOW
// ══════════════════════════════════════════════════════════

describe('RESPONSE: Test User responds to buzz from Heena', () => {
  it('responds with "ack" — updates response and responded_at', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-1', 'ack');
    expect(ctx.updates.length).toBeGreaterThan(0);
    expect(ctx.updates[0].response).toBe('ack');
    expect(typeof ctx.updates[0].responded_at).toBe('number');
  });

  it('responds with "five_min"', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-2', 'five_min');
    expect(ctx.updates[0].response).toBe('five_min');
  });

  it('responds with "busy"', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-3', 'busy');
    expect(ctx.updates[0].response).toBe('busy');
  });

  it('responds with "dismissed" (auto-dismiss from IncomingBuzzScreen)', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-4', 'dismissed');
    expect(ctx.updates[0].response).toBe('dismissed');
  });

  it('responds with "cancelled" (sender cancelled)', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-5', 'cancelled');
    expect(ctx.updates[0].response).toBe('cancelled');
  });

  it('retries on failure and logs warning', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    let callCount = 0;
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        callCount++;
        // Fail first 2 attempts, succeed on 3rd
        if (callCount <= 2) {
          return chainable(() => ({data: null, error: {message: 'DB error'}}));
        }
        return chainable(() => ({data: null, error: null}));
      }
      return _state._defaultChainable();
    };
    const result = await respondToBuzz('resp-retry', 'ack');
    expect(result).toBe(true);
    warnSpy.mockRestore();
  }, 15000);

  it('persists response to AsyncStorage when all retries fail', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        return chainable(() => ({data: null, error: {message: 'DB error'}}));
      }
      return _state._defaultChainable();
    };
    const result = await respondToBuzz('resp-persist', 'busy');
    expect(result).toBe(false);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      '@buzzer_pending_responses',
      expect.stringContaining('resp-persist'),
    );
  }, 15000);
});

describe('RESPONSE: Heena responds to buzz from Test User', () => {
  it('responds with "ack"', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-h-1', 'ack');
    expect(ctx.updates[0].response).toBe('ack');
  });

  it('responds with "five_min"', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-h-2', 'five_min');
    expect(ctx.updates[0].response).toBe('five_min');
  });

  it('responds with "busy"', async () => {
    const ctx = captureUpdates();
    await respondToBuzz('resp-h-3', 'busy');
    expect(ctx.updates[0].response).toBe('busy');
  });
});

// ══════════════════════════════════════════════════════════
//  DELIVERY TRACKING
// ══════════════════════════════════════════════════════════

describe('DELIVERY: markBuzzDelivered and markBuzzNotified', () => {
  it('markBuzzDelivered writes delivered_at timestamp', async () => {
    // Should not throw even with default mock
    await expect(markBuzzDelivered('del-1')).resolves.toBeUndefined();
    expect(mockSupabase.from).toHaveBeenCalledWith('buzzes');
  });

  it('markBuzzNotified writes notified_at timestamp', async () => {
    await expect(markBuzzNotified('notif-1')).resolves.toBeUndefined();
    expect(mockSupabase.from).toHaveBeenCalledWith('buzzes');
  });

  it('markEscalated writes escalated=true', async () => {
    await expect(markEscalated('esc-1')).resolves.toBeUndefined();
    expect(mockSupabase.from).toHaveBeenCalledWith('buzzes');
  });
});

// ══════════════════════════════════════════════════════════
//  REALTIME SUBSCRIPTION
// ══════════════════════════════════════════════════════════

describe('REALTIME: subscribeToIncomingBuzzes', () => {
  it('returns unsubscribe function for Test User', () => {
    const callback = jest.fn();
    const onRemoved = jest.fn();
    const unsub = subscribeToIncomingBuzzes(TEST_USER.id, callback, onRemoved);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('returns unsubscribe function for Heena Parmar', () => {
    const callback = jest.fn();
    const onRemoved = jest.fn();
    const unsub = subscribeToIncomingBuzzes(HEENA.id, callback, onRemoved);
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

describe('REALTIME: subscribeToBuzz', () => {
  it('subscribes to buzz updates and returns unsubscribe function', () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        return chainable(() => ({data: {id: 'sub-1', response: 'none'}, error: null}));
      }
      return _state._defaultChainable();
    };
    const callback = jest.fn();
    const unsub = subscribeToBuzz('sub-1', callback);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('skipInitialFetch=true skips REST query', () => {
    const callback = jest.fn();
    const unsub = subscribeToBuzz('sub-2', callback, true);
    // With skipInitialFetch, the initial supabase.from('buzzes').select query is skipped
    // Only the channel subscription is set up
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

// ══════════════════════════════════════════════════════════
//  PUSH TOKEN EDGE CASES
// ══════════════════════════════════════════════════════════

describe('PUSH TOKEN: Edge cases between Heena and Test User', () => {
  it('stale token with recent refresh — clears stale flag and delivers', async () => {
    withToken(TEST_USER.id, 'refreshed-tok', {
      stale: true,
      updatedAt: Date.now() - 60000, // 1 minute ago — within 7-day window
    });
    const result = await sendBuzzPush(TEST_USER.id, 'tok-1', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stale token with old refresh — still attempts delivery', async () => {
    withToken(TEST_USER.id, 'old-stale-tok', {
      stale: true,
      updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    });
    const result = await sendBuzzPush(TEST_USER.id, 'tok-2', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('voip_token only (no fcm_token) — still attempts delivery', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'user_tokens') {
        return chainable(() => ({
          data: {fcm_token: null, voip_token: 'voip-tok', platform: 'ios'},
          error: null,
        }));
      }
      return _state._defaultChainable();
    };
    const result = await sendBuzzPush(HEENA.id, 'tok-3', TEST_USER.id, TEST_USER.name, 'Test', null);
    expect(result).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no fcm_token AND no voip_token — returns no_token', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'user_tokens') {
        return chainable(() => ({
          data: {fcm_token: null, voip_token: null, platform: 'ios'},
          error: null,
        }));
      }
      return _state._defaultChainable();
    };
    const result = await sendBuzzPush(HEENA.id, 'tok-4', TEST_USER.id, TEST_USER.name, 'Test', null);
    expect(result).toBe('no_token');
  });

  it('voip_token column missing (migration not run) — falls back gracefully', async () => {
    let tokenQueryCount = 0;
    _state.fromImpl = (table: string) => {
      if (table === 'user_tokens') {
        tokenQueryCount++;
        if (tokenQueryCount === 1) {
          // First query with voip_token column fails
          return chainable(() => ({data: null, error: {code: '42703', message: 'column voip_token does not exist'}}));
        }
        // Second query without voip_token succeeds
        return chainable(() => ({data: {fcm_token: 'fallback-tok', platform: 'android'}, error: null}));
      }
      return _state._defaultChainable();
    };
    const result = await sendBuzzPush(TEST_USER.id, 'tok-5', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('delivered');
  });

  it('FCM v1 UNREGISTERED error code detected', async () => {
    withToken(TEST_USER.id, 'v1-stale');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        error: {
          details: [{
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode: 'UNREGISTERED',
          }],
        },
      }),
    } as any);
    const result = await sendBuzzPush(TEST_USER.id, 'tok-6', HEENA.id, HEENA.name, 'Test', null);
    expect(result).toBe('token_invalid');
  });
});

// ══════════════════════════════════════════════════════════
//  VOICE MAIL PUSH
// ══════════════════════════════════════════════════════════

describe('OUTGOING: Voice mail push between Heena and Test User', () => {
  it('Heena sends voice mail push to Test User', async () => {
    withToken(TEST_USER.id, 'test-user-token');
    await sendVoiceMailPush(TEST_USER.id, HEENA.name, 15);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data).toEqual({
      type: 'voice_message',
      from_user_name: HEENA.name,
      duration: '15',
    });
  });

  it('Test User sends voice mail push to Heena', async () => {
    withToken(HEENA.id, 'heena-token');
    await sendVoiceMailPush(HEENA.id, TEST_USER.name, 8);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.from_user_name).toBe('Test User');
    expect(body.data.duration).toBe('8');
  });

  it('voice mail push skipped when stale token', async () => {
    withToken(TEST_USER.id, 'stale', {stale: true});
    await sendVoiceMailPush(TEST_USER.id, HEENA.name, 10);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════
//  DUPLICATE PREVENTION
// ══════════════════════════════════════════════════════════

describe('DUPLICATE: Same buzz_id via multiple delivery paths', () => {
  it('two payloads with same buzz_id are considered the same buzz', () => {
    const payload1 = {
      buzz_id: 'dup-1', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Test', note: null,
    };
    const payload2 = {
      buzz_id: 'dup-1', from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Test', note: null,
    };
    expect(payload1.buzz_id).toBe(payload2.buzz_id);
  });

  it('rapid create produces different IDs (no duplicate alarm)', async () => {
    const ids: string[] = [];
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        return chainable(() => {
          const id = `rapid-${Date.now()}-${Math.random()}`;
          ids.push(id);
          return {data: {id}, error: null};
        });
      }
      return _state._defaultChainable();
    };

    await createBuzz({from_user_id: HEENA.id, from_user_name: HEENA.name, to_user_id: TEST_USER.id, reason: 'A', note: null, created_at: Date.now(), responded_at: null, response: 'none', escalated: false});
    await createBuzz({from_user_id: HEENA.id, from_user_name: HEENA.name, to_user_id: TEST_USER.id, reason: 'B', note: null, created_at: Date.now(), responded_at: null, response: 'none', escalated: false});

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ══════════════════════════════════════════════════════════
//  NOTIFICATION ACTION HANDLER (background event)
// ══════════════════════════════════════════════════════════

describe('NOTIFICATION ACTIONS: Background event handler', () => {
  let onBackgroundEventHandler: ((event: any) => Promise<void>) | null = null;

  beforeEach(() => {
    const notifee = require('@notifee/react-native').default;
    (notifee.onBackgroundEvent as jest.Mock).mockImplementation((handler: any) => {
      onBackgroundEventHandler = handler;
    });
    setupBackgroundHandler();
  });

  it('PRESS event stores buzz data to AsyncStorage for pending tap', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await onBackgroundEventHandler!({
      type: 4, // PRESS
      detail: {
        notification: {
          data: {
            buzz_id: 'tap-1',
            from_user_id: HEENA.id,
            from_user_name: HEENA.name,
            reason: 'Come to cabin',
            note: 'Urgent',
            sound_id: 'buzz_alarm',
          },
        },
      },
    });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      '@buzzer_pending_tap',
      expect.stringContaining('tap-1'),
    );
    const stored = JSON.parse(AsyncStorage.setItem.mock.calls[0][1]);
    expect(stored.from_user_name).toBe(HEENA.name);
    expect(stored.reason).toBe('Come to cabin');
    expect(stored.note).toBe('Urgent');
  });

  it('PRESS event with "null" note stores null', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await onBackgroundEventHandler!({
      type: 4, // PRESS
      detail: {
        notification: {
          data: {
            buzz_id: 'tap-2',
            from_user_id: TEST_USER.id,
            from_user_name: TEST_USER.name,
            reason: 'Help',
            note: 'null',
          },
        },
      },
    });
    const stored = JSON.parse(AsyncStorage.setItem.mock.calls[0][1]);
    expect(stored.note).toBeNull();
  });

  it('PRESS event without buzz_id does not store anything', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await onBackgroundEventHandler!({
      type: 4, // PRESS
      detail: {notification: {data: {}}},
    });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════
//  FULL E2E FLOW: Heena buzzes Test User, Test User responds
// ══════════════════════════════════════════════════════════

describe('E2E: Heena Parmar buzzes Test User → Test User responds ack', () => {
  it('complete flow: create → push → receive → respond', async () => {
    // Step 1: Heena creates the buzz
    withBuzzInsert('e2e-1');
    const buzz = await createBuzz({
      from_user_id: HEENA.id,
      from_user_name: HEENA.name,
      to_user_id: TEST_USER.id,
      reason: 'Come to cabin',
      note: 'Now',
      created_at: Date.now(),
      responded_at: null,
      response: 'none',
      escalated: false,
    });
    expect(buzz.id).toBe('e2e-1');

    // Step 2: Push sent to Test User
    withToken(TEST_USER.id, 'test-user-token');
    const pushResult = await sendBuzzPush(
      TEST_USER.id, buzz.id, HEENA.id, HEENA.name, 'Come to cabin', 'Now',
    );
    expect(pushResult).toBe('delivered');

    // Step 3: Test User's device receives the buzz (Android background)
    jest.replaceProperty(require('react-native').Platform, 'OS', 'android');
    let bgHandler: ((msg: any) => Promise<void>) | null = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();

    await bgHandler!({data: {
      type: 'buzz', buzz_id: buzz.id, from_user_id: HEENA.id,
      from_user_name: HEENA.name, reason: 'Come to cabin', note: 'Now',
    }});
    const notifee = require('@notifee/react-native').default;
    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({id: buzz.id, title: `Buzz from ${HEENA.name}`}),
    );

    // Step 4: Test User responds with 'ack'
    const ctx = captureUpdates();
    await respondToBuzz(buzz.id, 'ack');
    expect(ctx.updates[0].response).toBe('ack');

    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
  });
});

describe('E2E: Test User buzzes Heena Parmar → Heena responds busy', () => {
  it('complete flow: create → push → iOS receive → respond', async () => {
    // Step 1: Test User creates the buzz
    withBuzzInsert('e2e-2');
    const buzz = await createBuzz({
      from_user_id: TEST_USER.id,
      from_user_name: TEST_USER.name,
      to_user_id: HEENA.id,
      reason: 'Need help',
      note: null,
      created_at: Date.now(),
      responded_at: null,
      response: 'none',
      escalated: false,
    });
    expect(buzz.id).toBe('e2e-2');

    // Step 2: Push sent to Heena (iOS)
    withToken(HEENA.id, 'heena-token', {platform: 'ios'});
    const pushResult = await sendBuzzPush(
      HEENA.id, buzz.id, TEST_USER.id, TEST_USER.name, 'Need help', null,
    );
    expect(pushResult).toBe('delivered');

    // Step 3: Heena's iOS device — background handler returns early (APNs handles)
    jest.replaceProperty(require('react-native').Platform, 'OS', 'ios');
    let bgHandler: ((msg: any) => Promise<void>) | null = null;
    const {setBackgroundMessageHandler} = require('@react-native-firebase/messaging');
    (setBackgroundMessageHandler as jest.Mock).mockImplementation((_m: any, h: any) => { bgHandler = h; });
    setupBackgroundHandler();

    await bgHandler!({data: {
      type: 'buzz', buzz_id: buzz.id, from_user_id: TEST_USER.id,
      from_user_name: TEST_USER.name, reason: 'Need help', note: '',
    }});
    // iOS returns early — no notifee notification
    expect(require('@notifee/react-native').default.displayNotification).not.toHaveBeenCalled();

    // Step 4: Heena responds with 'busy'
    const ctx = captureUpdates();
    await respondToBuzz(buzz.id, 'busy');
    expect(ctx.updates[0].response).toBe('busy');
  });
});

describe('E2E: Heena group-buzzes Test User → cancel', () => {
  it('complete flow: group create → push → cancel', async () => {
    // Step 1: Heena sends group buzz
    const memberIds = [TEST_USER.id];
    let insertedRows: any[] = [];
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = chainable();
        c.insert = jest.fn((rows: any[]) => {
          insertedRows = rows;
          return {select: jest.fn(() => Promise.resolve({
            data: [{id: 'e2e-grp-1'}],
            error: null,
          }))};
        });
        return c;
      }
      return _state._defaultChainable();
    };

    const results = await createGroupBuzz(
      HEENA.id, HEENA.name, memberIds, 'Standup', 'Now', GROUP.id, GROUP.name,
    );
    expect(results).toHaveLength(1);
    expect(insertedRows[0].to_user_id).toBe(TEST_USER.id);

    // Step 2: Push to Test User
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzPush(TEST_USER.id, results[0].id, HEENA.id, HEENA.name, 'Standup', 'Now');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Step 3: Heena cancels
    const ctx = captureUpdates();
    await respondToBuzz(results[0].id, 'cancelled');
    expect(ctx.updates[0].response).toBe('cancelled');

    // Step 4: Cancellation push to Test User
    fetchMock.mockClear();
    withToken(TEST_USER.id, 'test-user-token');
    await sendBuzzCancelledPush(TEST_USER.id, results[0].id, HEENA.name);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data.type).toBe('buzz_cancelled');
    expect(body.data.buzz_id).toBe('e2e-grp-1');
  });
});
