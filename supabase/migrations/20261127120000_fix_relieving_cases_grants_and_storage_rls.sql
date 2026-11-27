-- Migration: 20261127120000_fix_relieving_cases_grants_and_storage_rls.sql
-- Description:
--   Root cause fix for PostgreSQL 42501 ("permission denied for table relieving_cases")
--   when HR or employees open files in storage.objects (including KYC docs in employee-documents):
--   1. Adds minimum required SQL table privileges on public.relieving_cases for authenticated
--      while explicitly keeping PUBLIC and anon revoked and RLS enabled.
--   2. Replaces the inline subquery in the relieving-documents storage RLS policy with a
--      narrowly scoped SECURITY DEFINER helper with locked search_path so SELECT policies on
--      other storage buckets (like employee-documents) never fail on cross-table privilege checks.
--   3. Splits relieving_cases_admin_hr_all so 'admin' has read-only RLS and only 'hr'/'super_admin' can mutate.

-- 1. Narrowly scoped helper to check whether the calling user owns an approved/relieved letter PDF
CREATE OR REPLACE FUNCTION public.can_read_own_relieving_letter(
  _object_name text,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.relieving_cases rc
    WHERE rc.letter_pdf_path = _object_name
      AND rc.user_id = _user_id
      AND rc.status IN ('approved', 'relieved')
  );
$$;

REVOKE ALL ON FUNCTION public.can_read_own_relieving_letter(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_own_relieving_letter(text, uuid) TO authenticated, service_role;

-- 2. Minimum required table privileges on public.relieving_cases (strict RLS remains enforced)
REVOKE ALL ON public.relieving_cases FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relieving_cases TO authenticated;
GRANT ALL ON public.relieving_cases TO service_role;

-- 3. Ensure read vs write RLS policies on public.relieving_cases follow least privilege
ALTER TABLE public.relieving_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS relieving_cases_admin_hr_all ON public.relieving_cases;
DROP POLICY IF EXISTS relieving_cases_authorized_read ON public.relieving_cases;
DROP POLICY IF EXISTS relieving_cases_hr_insert ON public.relieving_cases;
DROP POLICY IF EXISTS relieving_cases_hr_update ON public.relieving_cases;
DROP POLICY IF EXISTS relieving_cases_hr_delete ON public.relieving_cases;

CREATE POLICY relieving_cases_authorized_read
  ON public.relieving_cases
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'hr', 'admin')
    )
  );

CREATE POLICY relieving_cases_hr_insert
  ON public.relieving_cases
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'hr')
    )
  );

CREATE POLICY relieving_cases_hr_update
  ON public.relieving_cases
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'hr')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'hr')
    )
  );

CREATE POLICY relieving_cases_hr_delete
  ON public.relieving_cases
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'hr')
    )
  );

-- 4. Update storage policy on relieving-documents to use the locked-down helper
DROP POLICY IF EXISTS "Employees can read their own relieving letter" ON storage.objects;
CREATE POLICY "Employees can read their own relieving letter"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'relieving-documents'
    AND public.can_read_own_relieving_letter(name, auth.uid())
  );
