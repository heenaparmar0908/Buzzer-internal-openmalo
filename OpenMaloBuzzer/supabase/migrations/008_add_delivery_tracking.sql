-- Track when the receiver's device first showed the buzz notification
-- and when the receiver actually opened IncomingBuzzScreen to view it.
-- These let the sender know if the buzz was delivered vs lost.
ALTER TABLE buzzes ADD COLUMN IF NOT EXISTS notified_at BIGINT;
ALTER TABLE buzzes ADD COLUMN IF NOT EXISTS delivered_at BIGINT;

-- Push delivery tracking: when push was sent, the result, and retry count.
-- Enables debugging failed deliveries and server-side retry logic.
ALTER TABLE buzzes ADD COLUMN IF NOT EXISTS push_sent_at BIGINT;
ALTER TABLE buzzes ADD COLUMN IF NOT EXISTS push_result TEXT;      -- 'delivered','no_token','token_invalid','failed','retry_delivered'
ALTER TABLE buzzes ADD COLUMN IF NOT EXISTS push_attempts INTEGER NOT NULL DEFAULT 0;

-- iOS VoIP push token for CallKit integration (WhatsApp-style delivery).
-- Stored separately from fcm_token because VoIP tokens come from PushKit,
-- not Firebase, and must be sent directly to APNs (not through FCM).
ALTER TABLE user_tokens ADD COLUMN IF NOT EXISTS voip_token TEXT;

-- Index for the pending-buzz recovery query used by native polling
-- and the JS checkPending safety net. Covers the most common filter:
-- to_user_id + response IN ('none','auto_dismissed') ordered by created_at.
CREATE INDEX IF NOT EXISTS idx_buzzes_pending
  ON buzzes (to_user_id, response, created_at DESC)
  WHERE response IN ('none', 'auto_dismissed');
