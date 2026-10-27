/**
 * @format
 */

// Supabase mock — must be before App import
jest.mock('../src/services/supabase', () => {
  const mockChainable = (): any => {
    const obj: any = {};
    for (const m of ['select','insert','update','upsert','delete','eq','neq','in','gte','limit','order','range','single','maybeSingle']) {
      obj[m] = jest.fn().mockReturnValue(obj);
    }
    obj.then = jest.fn((cb: any) => { cb({data: null, error: null}); return Promise.resolve(); });
    return obj;
  };
  return {
    supabase: {
      from: jest.fn(() => mockChainable()),
      channel: jest.fn(() => ({on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis()})),
      removeChannel: jest.fn(),
      storage: {from: jest.fn(() => ({upload: jest.fn(), getPublicUrl: jest.fn(() => ({data: {publicUrl: ''}}))}))},
    },
    VOICE_MAIL_BUCKET: 'voice-mails',
    uploadVoiceMail: jest.fn(),
  };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
