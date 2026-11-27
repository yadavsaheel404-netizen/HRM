-- Migration: 20261127130000_smart_notifications_deep_links.sql
-- Description:
--   Additive upgrade to public.notifications adding structured deep-link metadata
--   without deleting, mutating, or invalidating any historical notifications.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS action_url text,
  ADD COLUMN IF NOT EXISTS section text,
  ADD COLUMN IF NOT EXISTS action_label text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_action_url_internal_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_action_url_internal_check
  CHECK (
    action_url IS NULL
    OR (
      action_url LIKE '/%'
      AND action_url NOT LIKE '//%'
      AND action_url NOT LIKE '%://%'
    )
  );

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications (user_id, read_at, created_at DESC);
