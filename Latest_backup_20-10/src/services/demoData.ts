import {User, Buzz, Reason} from '../types';

const DEMO_USERS_DATA: Omit<User, 'pin_hash'>[] = [
  {id: 'u1', name: 'Denish', phone: '9999999999', role: 'owner', last_seen_at: Date.now(), is_active: true},
  {id: 'u2', name: 'Priya', phone: '8888888888', role: 'manager', last_seen_at: Date.now(), is_active: true},
  {id: 'u3', name: 'Rahul', phone: '7777777777', role: 'member', last_seen_at: Date.now() - 60000, is_active: true},
  {id: 'u4', name: 'Sneha', phone: '6666666666', role: 'member', last_seen_at: Date.now(), is_active: true},
  {id: 'u5', name: 'Amit', phone: '5555555555', role: 'member', last_seen_at: Date.now() - 300000, is_active: true},
  {id: 'u6', name: 'Kavita', phone: '4444444444', role: 'member', last_seen_at: Date.now(), is_active: true},
  {id: 'u7', name: 'Vikram', phone: '3333333333', role: 'member', last_seen_at: Date.now() - 500000, is_active: true},
  {id: 'u8', name: 'Meena', phone: '2222222222', role: 'member', last_seen_at: Date.now(), is_active: true},
  {id: 'u9', name: 'Heena', phone: '9016642910', role: 'manager', last_seen_at: Date.now(), is_active: true},
];

export const DEMO_USERS: User[] = __DEV__
  ? DEMO_USERS_DATA.map(u => ({...u, pin_hash: ''}))
  : [];

export const DEMO_REASONS: Reason[] = __DEV__
  ? [
      {id: 'r1', label: 'Guest at reception', sort_order: 0, is_active: true},
      {id: 'r2', label: 'Urgent client call', sort_order: 1, is_active: true},
      {id: 'r3', label: 'Client on hold', sort_order: 2, is_active: true},
      {id: 'r4', label: 'Need you at my desk', sort_order: 3, is_active: true},
      {id: 'r5', label: 'Come to cabin', sort_order: 4, is_active: true},
      {id: 'r6', label: 'Urgent — call me now', sort_order: 5, is_active: true},
    ]
  : [];

const now = Date.now();
export const DEMO_BUZZES: Buzz[] = __DEV__
  ? [
      {id: 'b1', from_user_id: 'u1', to_user_id: 'u2', reason: 'Guest at reception', note: null, created_at: now - 3600000, responded_at: now - 3600000 + 8000, response: 'ack', escalated: false},
      {id: 'b2', from_user_id: 'u2', to_user_id: 'u3', reason: 'Urgent client call', note: 'Anthony on line 2', created_at: now - 7200000, responded_at: now - 7200000 + 45000, response: 'five_min', escalated: false},
      {id: 'b3', from_user_id: 'u1', to_user_id: 'u4', reason: 'Come to cabin', note: null, created_at: now - 10800000, responded_at: null, response: 'none', escalated: true},
      {id: 'b4', from_user_id: 'u1', to_user_id: 'u6', reason: 'Need you at my desk', note: null, created_at: now - 86400000, responded_at: now - 86400000 + 5000, response: 'ack', escalated: false},
      {id: 'b5', from_user_id: 'u2', to_user_id: 'u5', reason: 'Client on hold', note: 'Flipkart team', created_at: now - 172800000, responded_at: now - 172800000 + 120000, response: 'busy', escalated: true},
    ]
  : [];
