export const MAX_REASONS = 8;
export const MAX_NOTE_LENGTH = 40;
export const REBUZZ_TIMEOUT_MS = 60000;
export const NO_RESPONSE_TIMEOUT_MS = 120000;
export const PRESENCE_TIMEOUT_MS = 120000; // 2 minutes

export const NOTIFICATION_CHANNEL_ID = 'openmalo_buzz';
export const NOTIFICATION_CHANNEL_NAME = 'OpenMalo Buzz';

export const COLLECTIONS = {
  USERS: 'users',
  BUZZES: 'buzzes',
  USER_TOKENS: 'user_tokens',
  REASONS: 'reasons',
  SETTINGS: 'settings',
  GROUPS: 'groups',
  CALL_LOGS: 'call_logs',
  VOICE_MAILS: 'voice_mails',
} as const;
