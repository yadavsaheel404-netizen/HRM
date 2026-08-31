-- Invitation payload: what the invited person should become once provisioned.
ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS role public.app_role NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS category public.user_category NOT NULL DEFAULT 'full_time',
  ADD COLUMN IF NOT EXISTS designation text,
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reporting_lead_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS invitations_dispatch_idx
  ON public.invitations (status, next_attempt_at);

-- Atomically claim a bounded batch of due invitations. SKIP LOCKED means two
-- concurrent workers can never grab the same row, so no duplicate sends.
CREATE OR REPLACE FUNCTION public.claim_invitations(_limit int)
RETURNS SETOF public.invitations
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.invitations i
  SET status = 'sending', updated_at = now()
  WHERE i.id IN (
    SELECT id FROM public.invitations
    WHERE status = 'queued'
      AND next_attempt_at <= now()
      AND expires_at > now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(_limit, 0)
  )
  RETURNING i.*;
$$;

REVOKE ALL ON FUNCTION public.claim_invitations(int) FROM PUBLIC, anon, authenticated;

-- Single-flight lease so overlapping cron ticks do not double-dispatch.
CREATE OR REPLACE FUNCTION public.acquire_job_lease(_job_name text, _seconds int)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ok boolean;
BEGIN
  INSERT INTO public.job_leases (job_name, locked_until, locked_at)
  VALUES (_job_name, now() + make_interval(secs => _seconds), now())
  ON CONFLICT (job_name) DO UPDATE
    SET locked_until = now() + make_interval(secs => _seconds),
        locked_at = now()
    WHERE public.job_leases.locked_until < now()
      AND public.job_leases.paused = false
  RETURNING true INTO ok;

  RETURN COALESCE(ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_job_lease(text, int) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.release_job_lease(_job_name text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.job_leases SET locked_until = now() WHERE job_name = _job_name;
$$;

REVOKE ALL ON FUNCTION public.release_job_lease(text) FROM PUBLIC, anon, authenticated;