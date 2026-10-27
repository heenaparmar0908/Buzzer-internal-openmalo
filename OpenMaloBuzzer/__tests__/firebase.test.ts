/**
 * Tests for firebase.ts data access functions — createBuzz, createGroupBuzz,
 * respondToBuzz, getRecentBuzzes, getBuzzLogPage, reasons CRUD, groups CRUD.
 */

jest.mock('../src/services/supabase', () => {
  const _state = {
    fromImpl: (_table: string): any => _state._defaultChainable(),
    _defaultChainable: () => {
      const obj: any = {};
      for (const m of ['select','insert','update','upsert','delete','eq','neq','in','gte','limit','order','range']) {
        obj[m] = jest.fn().mockReturnValue(obj);
      }
      obj.single = jest.fn(() => Promise.resolve({data: null, error: null}));
      obj.maybeSingle = jest.fn(() => Promise.resolve({data: null, error: null}));
      obj.then = jest.fn((cb: any) => Promise.resolve({data: null, error: null}).then(cb));
      return obj;
    },
  };
  return {
    supabase: {from: jest.fn((t: string) => _state.fromImpl(t)), channel: jest.fn(() => ({on: jest.fn().mockReturnThis(), subscribe: jest.fn()})), removeChannel: jest.fn()},
    _state,
    VOICE_MAIL_BUCKET: 'voice-mails',
    uploadVoiceMail: jest.fn(),
  };
});
jest.mock('@env', () => ({SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'test-key'}));
jest.mock('react-native-url-polyfill/auto', () => {});

import {createBuzz, createGroupBuzz, respondToBuzz, getUserName, getRecentBuzzes, getBuzzLogPage} from '../src/services/firebase';
const {_state, supabase: mockSupabase} = require('../src/services/supabase');

beforeEach(() => {
  jest.clearAllMocks();
  _state.fromImpl = () => _state._defaultChainable();
});

describe('createBuzz', () => {
  it('inserts a buzz and returns the id', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.single = jest.fn(() => Promise.resolve({data: {id: 'buzz-new'}, error: null}));
        return c;
      }
      return _state._defaultChainable();
    };
    const result = await createBuzz({
      from_user_id: 's1', to_user_id: 'r1', reason: 'Test',
      note: null, created_at: Date.now(), responded_at: null,
      response: 'none', escalated: false,
    });
    expect(result.id).toBe('buzz-new');
  });

  it('throws on Supabase error', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.single = jest.fn(() => Promise.resolve({data: null, error: {message: 'DB error'}}));
        return c;
      }
      return _state._defaultChainable();
    };
    await expect(createBuzz({
      from_user_id: 's1', to_user_id: 'r1', reason: 'Test',
      note: null, created_at: Date.now(), responded_at: null,
      response: 'none', escalated: false,
    })).rejects.toBeDefined();
  });
});

describe('createGroupBuzz', () => {
  it('creates one row per member with correct group metadata', async () => {
    let insertedRows: any[] = [];
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.insert = jest.fn((rows: any[]) => {
          insertedRows = rows;
          return {select: jest.fn(() => Promise.resolve({data: rows.map((_: any, i: number) => ({id: `gb-${i}`})), error: null}))};
        });
        return c;
      }
      return _state._defaultChainable();
    };
    const result = await createGroupBuzz('s1', 'Alice', ['m1', 'm2', 'm3'], 'Standup', 'Room A', 'g1', 'Dev Team');
    expect(result).toHaveLength(3);
    expect(insertedRows[0].group_id).toBe('g1');
    expect(insertedRows[0].group_name).toBe('Dev Team');
    expect(insertedRows[0].to_user_id).toBe('m1');
    expect(insertedRows[2].to_user_id).toBe('m3');
    expect(insertedRows[0].note).toBe('Room A');
  });

  it('handles empty member list', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.insert = jest.fn(() => ({select: jest.fn(() => Promise.resolve({data: [], error: null}))}));
        return c;
      }
      return _state._defaultChainable();
    };
    const result = await createGroupBuzz('s1', 'Alice', [], 'Test', null, 'g1', 'Empty');
    expect(result).toHaveLength(0);
  });
});

describe('respondToBuzz', () => {
  it('updates response and responded_at', async () => {
    let updateArgs: any = null;
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.update = jest.fn((data: any) => { updateArgs = data; return c; });
        c.eq = jest.fn(() => Promise.resolve({error: null}));
        return c;
      }
      return _state._defaultChainable();
    };
    await respondToBuzz('buzz-1', 'ack');
    expect(updateArgs).not.toBeNull();
    expect(updateArgs.response).toBe('ack');
    expect(typeof updateArgs.responded_at).toBe('number');
  });
});

describe('getUserName', () => {
  it('returns "User" for empty userId', async () => {
    expect(await getUserName('')).toBe('User');
  });

  it('returns name from Supabase', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'users') {
        const c = _state._defaultChainable();
        c.single = jest.fn(() => Promise.resolve({data: {name: 'Alice'}, error: null}));
        return c;
      }
      return _state._defaultChainable();
    };
    expect(await getUserName('u1')).toBe('Alice');
  });

  it('returns "User" when Supabase returns null', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'users') {
        const c = _state._defaultChainable();
        c.single = jest.fn(() => Promise.resolve({data: null, error: null}));
        return c;
      }
      return _state._defaultChainable();
    };
    expect(await getUserName('unknown')).toBe('User');
  });
});

describe('getBuzzLogPage', () => {
  it('returns hasMore=true when page is full', async () => {
    const fullPage = Array.from({length: 15}, (_, i) => ({id: `b${i}`, response: 'none', created_at: Date.now()}));
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.then = jest.fn((cb: any) => Promise.resolve({data: fullPage}).then(cb));
        return c;
      }
      return _state._defaultChainable();
    };
    const result = await getBuzzLogPage(0);
    expect(result.hasMore).toBe(true);
    expect(result.lastDoc).toBe(1);
    expect(result.buzzes).toHaveLength(15);
  });

  it('returns hasMore=false when page is partial', async () => {
    _state.fromImpl = (table: string) => {
      if (table === 'buzzes') {
        const c = _state._defaultChainable();
        c.then = jest.fn((cb: any) => Promise.resolve({data: [{id: 'b1'}]}).then(cb));
        return c;
      }
      return _state._defaultChainable();
    };
    const result = await getBuzzLogPage(2);
    expect(result.hasMore).toBe(false);
    expect(result.lastDoc).toBe(3);
  });
});
