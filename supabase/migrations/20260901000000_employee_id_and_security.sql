-- Migration: Employee ID Sequence, Welcome Email Tracking, and Forced Password Change

-- Sequence tracking table for atomic, globally unique incremental Employee IDs
CREATE TABLE IF NOT EXISTS public.employee_id_sequence (
  id integer PRIMARY KEY DEFAULT 1,
  last_val integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed with highest existing employee number if present
DO $$
DECLARE
  max_id integer := 0;
  r record;
  val integer;
BEGIN
  FOR r IN SELECT employee_code FROM public.profiles WHERE employee_code IS NOT NULL LOOP
    val := NULL;
    BEGIN
      val := substring(r.employee_code from '(\d+)$')::integer;
    EXCEPTION WHEN OTHERS THEN
      val := NULL;
    END;
    IF val IS NOT NULL AND val > max_id THEN
      max_id := val;
    END IF;
  END LOOP;

  INSERT INTO public.employee_id_sequence (id, last_val)
  VALUES (1, max_id)
  ON CONFLICT (id) DO UPDATE SET last_val = GREATEST(public.employee_id_sequence.last_val, max_id);
END $$;

-- Atomically increments and claims the next sequential Employee ID (format: TAS-001, TAS-002, ...)
CREATE OR REPLACE FUNCTION public.claim_next_employee_id()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num integer;
  formatted_id text;
BEGIN
  SELECT last_val + 1 INTO next_num
  FROM public.employee_id_sequence
  WHERE id = 1
  FOR UPDATE;

  IF next_num IS NULL THEN
    INSERT INTO public.employee_id_sequence (id, last_val) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET last_val = public.employee_id_sequence.last_val + 1
    RETURNING last_val INTO next_num;
  ELSE
    UPDATE public.employee_id_sequence SET last_val = next_num, updated_at = now() WHERE id = 1;
  END IF;

  formatted_id := 'TAS-' || lpad(next_num::text, 3, '0');
  RETURN formatted_id;
END;
$$;

-- Read-only preview of the next Employee ID that will be claimed (does not increment)
CREATE OR REPLACE FUNCTION public.peek_next_employee_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'TAS-' || lpad((COALESCE(last_val, 0) + 1)::text, 3, '0')
  FROM public.employee_id_sequence
  WHERE id = 1;
$$;

-- Add security and welcome email tracking columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz;

-- Permissions
GRANT SELECT ON public.employee_id_sequence TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_employee_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.peek_next_employee_id() TO authenticated, service_role;
