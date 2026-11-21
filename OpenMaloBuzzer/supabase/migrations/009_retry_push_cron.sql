-- Automatic retry for failed buzz pushes.
-- Calls the retry-pushes edge function every 30 seconds.
-- pg_cron minimum is 1 minute, so we use pg_net for the HTTP call
-- and schedule two calls per minute (at 0s and 30s offset).

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule retry every minute (pg_cron minimum interval)
SELECT cron.schedule(
  'retry-failed-pushes',
  '* * * * *',
  $$
  SELECT extensions.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/retry-pushes',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
