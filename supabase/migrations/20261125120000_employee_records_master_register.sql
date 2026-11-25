-- Migration: 20261125120000_employee_records_master_register.sql
-- Description: Permanent historical Employee Records Master Register (/records),
-- employment period history, bulk Excel/CSV import batches, Google Drive folder references,
-- executive read-only overview, strict RLS policies, and one-way loop-free Workforce sync.

-- 1. Historical Record Identifier Sequence & Generator
CREATE SEQUENCE IF NOT EXISTS public.employee_record_id_seq START 1;

CREATE OR REPLACE FUNCTION public.next_historical_record_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seq_val bigint;
BEGIN
  seq_val := nextval('public.employee_record_id_seq');
  RETURN 'TAS-REC-' || lpad(seq_val::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_historical_record_code() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_historical_record_code() TO authenticated, service_role;

-- 2. Permissions & Role Grants
INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('records:read:all', 'records', 'read', 'all', 'View the permanent historical Employee Records master register'),
  ('records:manage:all', 'records', 'manage', 'all', 'Create, update, import, match, link, and sync historical Employee Records'),
  ('records:documents:read', 'records', 'documents', 'read', 'View confidential Google Drive folder links, personal contact PII, and KYC document metadata in Records')
ON CONFLICT (key) DO UPDATE SET description = excluded.description;

INSERT INTO public.role_permissions (role, permission_key)
VALUES
  ('super_admin'::public.app_role, 'records:read:all'),
  ('super_admin'::public.app_role, 'records:manage:all'),
  ('super_admin'::public.app_role, 'records:documents:read'),
  ('hr'::public.app_role, 'records:read:all'),
  ('hr'::public.app_role, 'records:manage:all'),
  ('hr'::public.app_role, 'records:documents:read'),
  ('founder'::public.app_role, 'records:read:all')
ON CONFLICT (role, permission_key) DO NOTHING;

-- 3. Import Batches Table
CREATE TABLE IF NOT EXISTS public.employee_record_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key text NOT NULL UNIQUE,
  import_kind text NOT NULL DEFAULT 'employee_records'
    CHECK (import_kind IN ('employee_records', 'drive_folder_links')),
  file_name text NOT NULL,
  file_type text NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  matched_workforce_count integer NOT NULL DEFAULT 0,
  new_historical_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  needs_review_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('preview', 'processing', 'completed', 'failed', 'partial')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- 4. Master Employee Records Table
CREATE TABLE IF NOT EXISTS public.employee_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  historical_record_code text NOT NULL UNIQUE DEFAULT public.next_historical_record_code(),
  profile_id uuid UNIQUE REFERENCES public.profiles(id) ON DELETE SET NULL,
  tas_employee_code text,

  -- Identity
  first_name text NOT NULL,
  last_name text,
  display_name text NOT NULL,
  personal_email text,
  organization_email text,
  phone_number text,
  address text,

  -- Employment
  joining_date date,
  last_working_date date,
  employment_status text NOT NULL DEFAULT 'inactive'
    CHECK (employment_status IN ('active', 'inactive')),
  status_needs_review boolean NOT NULL DEFAULT false,
  status_source text NOT NULL DEFAULT 'needs_review'
    CHECK (status_source IN ('workforce_verified', 'relieving_record', 'hr_historical', 'hr_manual', 'needs_review')),
  employment_category text NOT NULL DEFAULT 'unknown'
    CHECK (employment_category IN ('full_time', 'intern', 'freelancer', 'trainer', 'unknown')),
  work_type text NOT NULL DEFAULT 'unknown'
    CHECK (work_type IN ('annotation', 'engineering', 'operations', 'hr', 'training', 'other', 'unknown')),
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  department_name text,
  designation text,
  reporting_manager_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reporting_manager_name text,
  legal_employer text,

  -- Documents & Drive Integration
  drive_folder_url text,
  drive_folder_name text,
  drive_folder_id text,
  drive_match_status text NOT NULL DEFAULT 'unmatched'
    CHECK (drive_match_status IN ('unmatched', 'proposed', 'verified', 'ambiguous')),
  drive_matched_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  drive_matched_at timestamptz,
  document_source text NOT NULL DEFAULT 'NONE'
    CHECK (document_source IN ('HISTORICAL_GOOGLE_DRIVE', 'HRM_KYC', 'BOTH', 'NONE')),
  document_availability_status text NOT NULL DEFAULT 'missing'
    CHECK (document_availability_status IN ('available', 'partial', 'missing')),
  kyc_summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Administrative Metadata
  source_type text NOT NULL DEFAULT 'manual_entry'
    CHECK (source_type IN ('historical_excel', 'workforce_sync', 'manual_entry')),
  source_import_batch_id uuid REFERENCES public.employee_record_import_batches(id) ON DELETE SET NULL,
  last_synced_at timestamptz,
  last_updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  record_completeness integer NOT NULL DEFAULT 0 CHECK (record_completeness BETWEEN 0 AND 100),
  missing_fields text[] NOT NULL DEFAULT '{}'::text[],
  match_confidence text NOT NULL DEFAULT 'exact'
    CHECK (match_confidence IN ('exact', 'high', 'needs_review', 'unmatched')),
  duplicate_review_status text NOT NULL DEFAULT 'clear'
    CHECK (duplicate_review_status IN ('clear', 'needs_review', 'resolved')),
  needs_review boolean NOT NULL DEFAULT false,
  review_reasons text[] NOT NULL DEFAULT '{}'::text[],
  notes text,
  raw_source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Employment History Table (Preserves multi-tenure / role / category transitions)
CREATE TABLE IF NOT EXISTS public.employee_employment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES public.employee_records(id) ON DELETE CASCADE,
  start_date date,
  end_date date,
  designation text,
  employment_category text NOT NULL DEFAULT 'unknown'
    CHECK (employment_category IN ('full_time', 'intern', 'freelancer', 'trainer', 'unknown')),
  work_type text NOT NULL DEFAULT 'unknown'
    CHECK (work_type IN ('annotation', 'engineering', 'operations', 'hr', 'training', 'other', 'unknown')),
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  department_name text,
  reporting_manager_name text,
  legal_employer text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'relieved', 'inactive', 'transferred')),
  source text NOT NULL DEFAULT 'manual_entry'
    CHECK (source IN ('historical_excel', 'workforce_sync', 'relieving_event', 'manual_entry')),
  is_current boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. Import Row Audit Table
CREATE TABLE IF NOT EXISTS public.employee_record_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.employee_record_import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_payload jsonb NOT NULL,
  normalized_payload jsonb NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('linked_workforce', 'created_historical', 'updated_historical', 'needs_review', 'skipped', 'excluded', 'error')),
  record_id uuid REFERENCES public.employee_records(id) ON DELETE SET NULL,
  matched_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  match_signal text,
  warnings text[] NOT NULL DEFAULT '{}'::text[],
  errors text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_number)
);

-- 7. Scale Indexes (5,000+ historical records)
CREATE INDEX IF NOT EXISTS idx_employee_records_org_email_lower
  ON public.employee_records (lower(organization_email));
CREATE INDEX IF NOT EXISTS idx_employee_records_personal_email_lower
  ON public.employee_records (lower(personal_email));
CREATE INDEX IF NOT EXISTS idx_employee_records_display_name_lower
  ON public.employee_records (lower(display_name));
CREATE INDEX IF NOT EXISTS idx_employee_records_phone
  ON public.employee_records (phone_number);
CREATE INDEX IF NOT EXISTS idx_employee_records_tas_code
  ON public.employee_records (tas_employee_code);
CREATE INDEX IF NOT EXISTS idx_employee_records_status
  ON public.employee_records (employment_status);
CREATE INDEX IF NOT EXISTS idx_employee_records_category
  ON public.employee_records (employment_category);
CREATE INDEX IF NOT EXISTS idx_employee_records_work_type
  ON public.employee_records (work_type);
CREATE INDEX IF NOT EXISTS idx_employee_records_dept
  ON public.employee_records (department_id);
CREATE INDEX IF NOT EXISTS idx_employee_records_doc_source
  ON public.employee_records (document_source);
CREATE INDEX IF NOT EXISTS idx_employee_records_needs_review
  ON public.employee_records (needs_review);
CREATE INDEX IF NOT EXISTS idx_employee_records_joining_date
  ON public.employee_records (joining_date);
CREATE INDEX IF NOT EXISTS idx_employee_records_lwd
  ON public.employee_records (last_working_date);
CREATE INDEX IF NOT EXISTS idx_employee_records_updated_at
  ON public.employee_records (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_employee_emp_history_record
  ON public.employee_employment_history (record_id, is_current DESC, start_date DESC);

CREATE INDEX IF NOT EXISTS idx_employee_record_import_rows_batch
  ON public.employee_record_import_rows (batch_id, outcome);

-- 8. Safe Executive Read-Only Overview View (omits confidential Drive URLs, raw PII & snapshots)
CREATE OR REPLACE VIEW public.employee_records_executive_overview
WITH (security_invoker = true) AS
SELECT
  id,
  historical_record_code,
  profile_id,
  tas_employee_code,
  first_name,
  last_name,
  display_name,
  organization_email,
  joining_date,
  last_working_date,
  employment_status,
  status_needs_review,
  status_source,
  employment_category,
  work_type,
  department_id,
  department_name,
  designation,
  reporting_manager_name,
  document_source,
  document_availability_status,
  kyc_summary,
  (drive_folder_url IS NOT NULL) AS has_drive_folder,
  source_type,
  record_completeness,
  needs_review,
  last_synced_at,
  created_at,
  updated_at
FROM public.employee_records
WHERE profile_id IS NULL OR NOT public.is_protected_account(profile_id);

REVOKE ALL ON public.employee_records_executive_overview FROM PUBLIC, anon;
GRANT SELECT ON public.employee_records_executive_overview TO authenticated, service_role;

-- 9. Updated-at Triggers
CREATE OR REPLACE FUNCTION public.set_employee_records_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_employee_records_updated_at ON public.employee_records;
CREATE TRIGGER trg_set_employee_records_updated_at
BEFORE UPDATE ON public.employee_records
FOR EACH ROW EXECUTE FUNCTION public.set_employee_records_updated_at();

DROP TRIGGER IF EXISTS trg_set_employee_emp_history_updated_at ON public.employee_employment_history;
CREATE TRIGGER trg_set_employee_emp_history_updated_at
BEFORE UPDATE ON public.employee_employment_history
FOR EACH ROW EXECUTE FUNCTION public.set_employee_records_updated_at();

-- 10. One-Way Idempotent Workforce -> Employee Records Synchronization
CREATE OR REPLACE FUNCTION public.sync_profile_to_employee_record(
  _profile_id uuid,
  _actor_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p record;
  v_dept_name text;
  v_lead_name text;
  v_relieved record;
  v_kyc record;
  v_kyc_json jsonb := '{}'::jsonb;
  v_has_kyc boolean := false;
  v_doc_uploaded integer := 0;
  v_record_id uuid;
  v_existing record;
  v_first_name text;
  v_last_name text;
  v_display_name text;
  v_name_parts text[];
  v_emp_status text;
  v_status_source text;
  v_lwd date;
  v_category text;
  v_work_type text;
  v_doc_source text;
  v_doc_avail text;
  v_has_drive boolean := false;
  v_missing text[] := '{}'::text[];
  v_score integer;
  v_hist record;
  v_hist_status text;
BEGIN
  IF _profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Never surface protected super_admin accounts inside Employee Records
  IF public.is_protected_account(_profile_id) THEN
    RETURN NULL;
  END IF;

  SELECT
    pr.id,
    pr.full_name,
    pr.work_email,
    pr.personal_email,
    pr.mobile,
    pr.current_address,
    pr.permanent_address,
    pr.category::text AS category,
    pr.work_type::text AS work_type,
    pr.designation,
    pr.department_id,
    pr.reporting_lead_id,
    pr.joining_date,
    pr.last_working_day,
    pr.employment_status::text AS employment_status,
    pr.employee_code
  INTO p
  FROM public.profiles pr
  WHERE pr.id = _profile_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p.department_id IS NOT NULL THEN
    SELECT name INTO v_dept_name FROM public.departments WHERE id = p.department_id;
  END IF;

  IF p.reporting_lead_id IS NOT NULL THEN
    SELECT full_name INTO v_lead_name FROM public.profiles WHERE id = p.reporting_lead_id;
  END IF;

  SELECT rc.status, rc.relieving_effective_date, rc.last_working_day, rc.legal_employer
  INTO v_relieved
  FROM public.relieving_cases rc
  WHERE rc.user_id = _profile_id
    AND rc.status = 'relieved'
  ORDER BY rc.relieved_at DESC NULLS LAST, rc.created_at DESC
  LIMIT 1;

  SELECT eks.* INTO v_kyc
  FROM public.employee_kyc_state eks
  WHERE eks.user_id = _profile_id;

  SELECT count(*)::integer INTO v_doc_uploaded
  FROM public.documents d
  WHERE d.user_id = _profile_id;

  IF FOUND THEN
    v_has_kyc := (v_doc_uploaded > 0 OR COALESCE(v_kyc.verified_count, 0) > 0 OR COALESCE(v_kyc.pending_count, 0) > 0);
    v_kyc_json := jsonb_build_object(
      'status', v_kyc.status,
      'requiredCount', COALESCE(v_kyc.required_count, 5),
      'uploadedCount', v_doc_uploaded,
      'verifiedCount', COALESCE(v_kyc.verified_count, 0),
      'pendingCount', COALESCE(v_kyc.pending_count, 0),
      'rejectedCount', COALESCE(v_kyc.rejected_count, 0),
      'missingCount', COALESCE(v_kyc.missing_count, 5),
      'completedAt', v_kyc.completed_at
    );
  ELSIF v_doc_uploaded > 0 THEN
    v_has_kyc := true;
    v_kyc_json := jsonb_build_object(
      'status', 'incomplete',
      'requiredCount', 5,
      'uploadedCount', v_doc_uploaded,
      'verifiedCount', 0,
      'pendingCount', v_doc_uploaded,
      'rejectedCount', 0,
      'missingCount', GREATEST(0, 5 - v_doc_uploaded)
    );
  END IF;

  v_display_name := NULLIF(btrim(COALESCE(p.full_name, '')), '');
  IF v_display_name IS NULL THEN
    v_display_name := split_part(COALESCE(p.work_email, 'Unknown Employee'), '@', 1);
  END IF;
  v_name_parts := regexp_split_to_array(v_display_name, '\s+');
  v_first_name := COALESCE(NULLIF(v_name_parts[1], ''), v_display_name);
  IF array_length(v_name_parts, 1) > 1 THEN
    v_last_name := array_to_string(v_name_parts[2:array_length(v_name_parts, 1)], ' ');
  ELSE
    v_last_name := NULL;
  END IF;

  -- Status classification precedence: relieving event > verified workforce status
  IF v_relieved.status = 'relieved' OR p.employment_status IN ('relieved', 'exited', 'inactive', 'on_hold') THEN
    v_emp_status := 'inactive';
    v_status_source := CASE WHEN v_relieved.status = 'relieved' THEN 'relieving_record' ELSE 'workforce_verified' END;
  ELSE
    v_emp_status := 'active';
    v_status_source := 'workforce_verified';
  END IF;

  v_lwd := COALESCE(v_relieved.relieving_effective_date, v_relieved.last_working_day, p.last_working_day);

  v_category := CASE
    WHEN p.category IN ('full_time', 'intern', 'freelancer', 'trainer') THEN p.category
    ELSE 'unknown'
  END;

  v_work_type := CASE
    WHEN p.work_type IN ('annotation', 'engineering', 'operations', 'hr', 'training', 'other') THEN p.work_type
    ELSE 'unknown'
  END;

  -- Find existing linked or exact-email unlinked record
  SELECT er.* INTO v_existing
  FROM public.employee_records er
  WHERE er.profile_id = _profile_id
  LIMIT 1;

  IF NOT FOUND AND NULLIF(btrim(COALESCE(p.work_email, '')), '') IS NOT NULL THEN
    SELECT er.* INTO v_existing
    FROM public.employee_records er
    WHERE er.profile_id IS NULL
      AND lower(er.organization_email) = lower(btrim(p.work_email))
    LIMIT 1;
  END IF;

  IF NOT FOUND AND NULLIF(btrim(COALESCE(p.personal_email, '')), '') IS NOT NULL THEN
    SELECT er.* INTO v_existing
    FROM public.employee_records er
    WHERE er.profile_id IS NULL
      AND lower(er.personal_email) = lower(btrim(p.personal_email))
    LIMIT 1;
  END IF;

  v_has_drive := (v_existing.id IS NOT NULL AND NULLIF(btrim(COALESCE(v_existing.drive_folder_url, '')), '') IS NOT NULL);

  v_doc_source := CASE
    WHEN v_has_drive AND v_has_kyc THEN 'BOTH'
    WHEN v_has_drive THEN 'HISTORICAL_GOOGLE_DRIVE'
    WHEN v_has_kyc THEN 'HRM_KYC'
    ELSE 'NONE'
  END;

  v_doc_avail := CASE
    WHEN v_has_drive OR COALESCE(v_kyc.verified_count, 0) >= COALESCE(v_kyc.required_count, 5) THEN 'available'
    WHEN v_has_kyc THEN 'partial'
    ELSE 'missing'
  END;

  -- Compute missing fields and completeness score
  IF COALESCE(NULLIF(v_last_name, ''), v_existing.last_name) IS NULL THEN v_missing := array_append(v_missing, 'last_name'); END IF;
  IF COALESCE(NULLIF(p.personal_email, ''), v_existing.personal_email) IS NULL THEN v_missing := array_append(v_missing, 'personal_email'); END IF;
  IF COALESCE(NULLIF(p.work_email, ''), v_existing.organization_email) IS NULL THEN v_missing := array_append(v_missing, 'organization_email'); END IF;
  IF COALESCE(NULLIF(p.mobile, ''), v_existing.phone_number) IS NULL THEN v_missing := array_append(v_missing, 'phone_number'); END IF;
  IF COALESCE(NULLIF(p.current_address, ''), NULLIF(p.permanent_address, ''), v_existing.address) IS NULL THEN v_missing := array_append(v_missing, 'address'); END IF;
  IF COALESCE(p.joining_date, v_existing.joining_date) IS NULL THEN v_missing := array_append(v_missing, 'joining_date'); END IF;
  IF v_category = 'unknown' THEN v_missing := array_append(v_missing, 'employment_category'); END IF;
  IF v_work_type = 'unknown' THEN v_missing := array_append(v_missing, 'work_type'); END IF;
  IF p.department_id IS NULL AND v_existing.department_id IS NULL AND v_existing.department_name IS NULL THEN v_missing := array_append(v_missing, 'department'); END IF;
  IF COALESCE(NULLIF(p.designation, ''), v_existing.designation) IS NULL THEN v_missing := array_append(v_missing, 'designation'); END IF;
  IF v_doc_source = 'NONE' THEN v_missing := array_append(v_missing, 'documents'); END IF;

  v_score := GREATEST(0, LEAST(100, round(((11 - array_length(v_missing, 1))::numeric / 11.0) * 100)::integer));
  IF array_length(v_missing, 1) IS NULL THEN
    v_score := 100;
  END IF;

  IF v_existing.id IS NOT NULL THEN
    -- Preserve archival historical values when Workforce fields are empty, never overwrite Drive link
    UPDATE public.employee_records SET
      profile_id = _profile_id,
      tas_employee_code = COALESCE(NULLIF(p.employee_code, ''), tas_employee_code),
      first_name = v_first_name,
      last_name = COALESCE(NULLIF(v_last_name, ''), last_name),
      display_name = v_display_name,
      personal_email = COALESCE(NULLIF(p.personal_email, ''), personal_email),
      organization_email = COALESCE(NULLIF(p.work_email, ''), organization_email),
      phone_number = COALESCE(NULLIF(p.mobile, ''), phone_number),
      address = COALESCE(NULLIF(p.current_address, ''), NULLIF(p.permanent_address, ''), address),
      joining_date = COALESCE(p.joining_date, joining_date),
      last_working_date = COALESCE(v_lwd, last_working_date),
      employment_status = v_emp_status,
      status_needs_review = false,
      status_source = v_status_source,
      employment_category = CASE WHEN v_category <> 'unknown' THEN v_category ELSE employment_category END,
      work_type = CASE WHEN v_work_type <> 'unknown' THEN v_work_type ELSE work_type END,
      department_id = COALESCE(p.department_id, department_id),
      department_name = COALESCE(v_dept_name, department_name),
      designation = COALESCE(NULLIF(p.designation, ''), designation),
      reporting_manager_id = COALESCE(p.reporting_lead_id, reporting_manager_id),
      reporting_manager_name = COALESCE(v_lead_name, reporting_manager_name),
      legal_employer = COALESCE(v_relieved.legal_employer, legal_employer, 'Learning Paths Technologies LLP'),
      document_source = v_doc_source,
      document_availability_status = v_doc_avail,
      kyc_summary = v_kyc_json,
      last_synced_at = now(),
      last_updated_by = COALESCE(_actor_id, last_updated_by),
      record_completeness = v_score,
      missing_fields = v_missing,
      match_confidence = 'exact'
    WHERE id = v_existing.id
    RETURNING id INTO v_record_id;
  ELSE
    INSERT INTO public.employee_records (
      profile_id,
      tas_employee_code,
      first_name,
      last_name,
      display_name,
      personal_email,
      organization_email,
      phone_number,
      address,
      joining_date,
      last_working_date,
      employment_status,
      status_needs_review,
      status_source,
      employment_category,
      work_type,
      department_id,
      department_name,
      designation,
      reporting_manager_id,
      reporting_manager_name,
      legal_employer,
      document_source,
      document_availability_status,
      kyc_summary,
      source_type,
      last_synced_at,
      last_updated_by,
      record_completeness,
      missing_fields,
      match_confidence,
      duplicate_review_status
    ) VALUES (
      _profile_id,
      p.employee_code,
      v_first_name,
      v_last_name,
      v_display_name,
      NULLIF(p.personal_email, ''),
      NULLIF(p.work_email, ''),
      NULLIF(p.mobile, ''),
      COALESCE(NULLIF(p.current_address, ''), NULLIF(p.permanent_address, '')),
      p.joining_date,
      v_lwd,
      v_emp_status,
      false,
      v_status_source,
      v_category,
      v_work_type,
      p.department_id,
      v_dept_name,
      NULLIF(p.designation, ''),
      p.reporting_lead_id,
      v_lead_name,
      COALESCE(v_relieved.legal_employer, 'Learning Paths Technologies LLP'),
      v_doc_source,
      v_doc_avail,
      v_kyc_json,
      'workforce_sync',
      now(),
      _actor_id,
      v_score,
      v_missing,
      'exact',
      'clear'
    )
    RETURNING id INTO v_record_id;
  END IF;

  -- Maintain employment period history without overwriting former periods on transitions/rejoins
  v_hist_status := CASE
    WHEN v_relieved.status = 'relieved' THEN 'relieved'
    WHEN v_emp_status = 'inactive' THEN 'inactive'
    ELSE 'active'
  END;

  SELECT * INTO v_hist
  FROM public.employee_employment_history eh
  WHERE eh.record_id = v_record_id
    AND eh.is_current = true
  ORDER BY eh.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.employee_employment_history (
      record_id, start_date, end_date, designation, employment_category, work_type,
      department_id, department_name, reporting_manager_name, legal_employer,
      status, source, is_current, created_by
    ) VALUES (
      v_record_id, p.joining_date, v_lwd, p.designation, v_category, v_work_type,
      p.department_id, v_dept_name, v_lead_name, COALESCE(v_relieved.legal_employer, 'Learning Paths Technologies LLP'),
      v_hist_status, CASE WHEN v_relieved.status = 'relieved' THEN 'relieving_event' ELSE 'workforce_sync' END,
      true, _actor_id
    );
  ELSIF COALESCE(v_hist.designation, '') IS DISTINCT FROM COALESCE(p.designation, '')
     OR v_hist.department_id IS DISTINCT FROM p.department_id
     OR v_hist.employment_category IS DISTINCT FROM v_category
     OR v_hist.work_type IS DISTINCT FROM v_work_type
     OR v_hist.status IS DISTINCT FROM v_hist_status THEN
    IF v_hist.status = 'active' AND v_hist_status IN ('relieved', 'inactive') THEN
      UPDATE public.employee_employment_history
      SET end_date = COALESCE(v_lwd, end_date),
          status = v_hist_status
      WHERE id = v_hist.id;
    ELSE
      UPDATE public.employee_employment_history
      SET is_current = false,
          end_date = COALESCE(end_date, CASE WHEN v_hist_status = 'active' AND v_hist.status <> 'active' THEN v_hist.end_date ELSE CURRENT_DATE END)
      WHERE id = v_hist.id;

      INSERT INTO public.employee_employment_history (
        record_id, start_date, end_date, designation, employment_category, work_type,
        department_id, department_name, reporting_manager_name, legal_employer,
        status, source, is_current, created_by
      ) VALUES (
        v_record_id,
        CASE WHEN v_hist.status IN ('relieved', 'inactive', 'completed') AND v_hist_status = 'active' THEN CURRENT_DATE ELSE p.joining_date END,
        v_lwd,
        p.designation,
        v_category,
        v_work_type,
        p.department_id,
        v_dept_name,
        v_lead_name,
        COALESCE(v_relieved.legal_employer, 'Learning Paths Technologies LLP'),
        v_hist_status,
        CASE WHEN v_relieved.status = 'relieved' THEN 'relieving_event' ELSE 'workforce_sync' END,
        true,
        _actor_id
      );
    END IF;
  END IF;

  RETURN v_record_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_profile_to_employee_record(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_profile_to_employee_record(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.sync_all_workforce_to_employee_records(_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_synced integer := 0;
  v_skipped integer := 0;
  v_res uuid;
BEGIN
  FOR v_row IN SELECT id FROM public.profiles ORDER BY created_at ASC LOOP
    IF public.is_protected_account(v_row.id) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_res := public.sync_profile_to_employee_record(v_row.id, _actor_id);
    IF v_res IS NOT NULL THEN
      v_synced := v_synced + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'synced', v_synced,
    'skippedProtected', v_skipped,
    'syncedAt', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_all_workforce_to_employee_records(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_all_workforce_to_employee_records(uuid) TO service_role;

-- Trigger functions (one-way: Workforce -> Records; Records never writes back to profiles)
CREATE OR REPLACE FUNCTION public.trg_sync_profile_to_employee_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_profile_to_employee_record(NEW.id, auth.uid());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_sync_employee_records ON public.profiles;
CREATE TRIGGER trg_profiles_sync_employee_records
AFTER INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_profile_to_employee_record();

CREATE OR REPLACE FUNCTION public.trg_relieving_sync_employee_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'relieved' THEN
    PERFORM public.sync_profile_to_employee_record(NEW.user_id, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_relieving_cases_sync_employee_records ON public.relieving_cases;
CREATE TRIGGER trg_relieving_cases_sync_employee_records
AFTER INSERT OR UPDATE OF status, relieving_effective_date ON public.relieving_cases
FOR EACH ROW EXECUTE FUNCTION public.trg_relieving_sync_employee_record();

CREATE OR REPLACE FUNCTION public.trg_kyc_state_sync_employee_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_profile_to_employee_record(NEW.user_id, NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kyc_state_sync_employee_records ON public.employee_kyc_state;
CREATE TRIGGER trg_kyc_state_sync_employee_records
AFTER INSERT OR UPDATE ON public.employee_kyc_state
FOR EACH ROW EXECUTE FUNCTION public.trg_kyc_state_sync_employee_record();

-- 11. Row-Level Security Policies
ALTER TABLE public.employee_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_employment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_record_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_record_import_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.employee_records FROM anon, authenticated;
REVOKE ALL ON public.employee_employment_history FROM anon, authenticated;
REVOKE ALL ON public.employee_record_import_batches FROM anon, authenticated;
REVOKE ALL ON public.employee_record_import_rows FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_records TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_employment_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_record_import_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_record_import_rows TO authenticated;

GRANT ALL ON public.employee_records TO service_role;
GRANT ALL ON public.employee_employment_history TO service_role;
GRANT ALL ON public.employee_record_import_batches TO service_role;
GRANT ALL ON public.employee_record_import_rows TO service_role;

-- employee_records policies
DROP POLICY IF EXISTS employee_records_select_authorized ON public.employee_records;
CREATE POLICY employee_records_select_authorized ON public.employee_records
FOR SELECT TO authenticated
USING (
  public.has_permission(auth.uid(), 'records:read:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr', 'founder')
  )
  AND (profile_id IS NULL OR NOT public.is_protected_account(profile_id))
);

DROP POLICY IF EXISTS employee_records_manage_hr_sa ON public.employee_records;
CREATE POLICY employee_records_manage_hr_sa ON public.employee_records
FOR ALL TO authenticated
USING (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
)
WITH CHECK (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
);

-- employee_employment_history policies
DROP POLICY IF EXISTS employee_employment_history_select_authorized ON public.employee_employment_history;
CREATE POLICY employee_employment_history_select_authorized ON public.employee_employment_history
FOR SELECT TO authenticated
USING (
  public.has_permission(auth.uid(), 'records:read:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr', 'founder')
  )
  AND EXISTS (
    SELECT 1 FROM public.employee_records er
    WHERE er.id = record_id
      AND (er.profile_id IS NULL OR NOT public.is_protected_account(er.profile_id))
  )
);

DROP POLICY IF EXISTS employee_employment_history_manage_hr_sa ON public.employee_employment_history;
CREATE POLICY employee_employment_history_manage_hr_sa ON public.employee_employment_history
FOR ALL TO authenticated
USING (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
)
WITH CHECK (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
);

-- import batches & rows: HR and Super Admin ONLY (Founder cannot access raw staging payloads)
DROP POLICY IF EXISTS employee_record_import_batches_hr_sa ON public.employee_record_import_batches;
CREATE POLICY employee_record_import_batches_hr_sa ON public.employee_record_import_batches
FOR ALL TO authenticated
USING (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
)
WITH CHECK (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
);

DROP POLICY IF EXISTS employee_record_import_rows_hr_sa ON public.employee_record_import_rows;
CREATE POLICY employee_record_import_rows_hr_sa ON public.employee_record_import_rows
FOR ALL TO authenticated
USING (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
)
WITH CHECK (
  public.has_permission(auth.uid(), 'records:manage:all')
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'hr')
  )
);
