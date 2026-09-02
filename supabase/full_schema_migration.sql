-- ==============================================================================
-- THE AI SCHOOL HRM PORTAL: FULL DATABASE MIGRATION & SCHEMA INITIALIZATION
-- Run this in the Supabase SQL Editor for project: qnvatbsbromzyjbddpif
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. ENUMS & TYPES
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('super_admin','founder','hr','admin','lead','employee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.user_category AS ENUM ('full_time','intern','freelancer','trainer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.account_status AS ENUM ('invited','activated','profile_pending','under_verification','active','deactivated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.employment_status AS ENUM ('active','inactive','on_hold','exited','resigned','terminated','on_leave','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.document_type AS ENUM ('resume','identity_proof','pan','bank_details','education','offer_letter','nda','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.document_status AS ENUM ('pending','verified','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.invitation_status AS ENUM ('queued','sending','sent','failed','accepted','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.project_status AS ENUM ('draft','active','on_hold','completed','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.work_mode AS ENUM ('onsite','remote','hybrid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.project_shift AS ENUM ('general','morning','evening','night','rotational','flexible');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.allocation_status AS ENUM ('pending_acknowledgment','active','paused','ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.attendance_work_mode AS ENUM ('wfo','wfh','hybrid','client_location','field_work');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.day_exception AS ENUM ('none','leave','holiday','weekly_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.attendance_status AS ENUM ('pending','approved','rejected','present','half_day','absent','on_leave','holiday','weekly_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.task_entry_status AS ENUM ('draft','submitted','reviewed','revision_required','approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.task_slot_type AS ENUM ('fixed','flexible');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.break_category AS ENUM ('lunch','short_break','personal','meeting','training','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.blocker_category AS ENUM ('data_quality','tooling','access','dependency','guidance','client','personal','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.blocker_severity AS ENUM ('low','medium','high','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.blocker_status AS ENUM ('open','acknowledged','resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.eod_status AS ENUM ('draft','submitted','reviewed','approved','revision_required','escalated','performance_concern');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.request_type AS ENUM ('leave','wfh','attendance_correction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.request_status AS ENUM ('pending','approved','rejected','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.approval_tier AS ENUM ('lead','hr');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.approval_decision AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.review_action AS ENUM ('approved','approved_with_comment','revision_requested','escalated','performance_concern');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. COMMON UTILITY FUNCTIONS
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 4. DEPARTMENTS TABLE
CREATE TABLE IF NOT EXISTS public.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  description text,
  lead_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. PROFILES TABLE
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  display_name text,
  work_email text UNIQUE,
  personal_email text,
  mobile text,
  category public.user_category DEFAULT 'full_time',
  designation text,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  reporting_lead_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  joining_date date,
  last_working_day date,
  work_location text DEFAULT 'hyderabad',
  account_status public.account_status DEFAULT 'active',
  employment_status public.employment_status DEFAULT 'active',
  employee_code text UNIQUE,
  photo_url text,
  date_of_birth date,
  current_address text,
  permanent_address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  skills text[],
  experience_years numeric,
  institution text,
  internship_start date,
  internship_end date,
  available_hours_per_day numeric DEFAULT 8,
  profile_submitted_at timestamptz,
  profile_verified_at timestamptz,
  profile_verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  needs_assignment boolean DEFAULT false,
  must_change_password boolean DEFAULT false,
  welcome_email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_reporting_lead ON public.profiles(reporting_lead_id);
CREATE INDEX IF NOT EXISTS idx_profiles_department ON public.profiles(department_id);

ALTER TABLE public.departments
  DROP CONSTRAINT IF EXISTS departments_lead_id_fkey,
  ADD CONSTRAINT departments_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 6. RBAC TABLES
CREATE TABLE IF NOT EXISTS public.permissions (
  key text PRIMARY KEY,
  resource text NOT NULL,
  action text NOT NULL,
  scope text NOT NULL,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.roles (
  role text PRIMARY KEY,
  label text NOT NULL,
  rank int NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role text NOT NULL REFERENCES public.roles(role) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_key)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Helper functions for RBAC
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = _user_id AND rp.permission_key = _permission
  ) OR EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND ur.role IN ('super_admin', 'founder')
  );
$$;

-- 7. DOCUMENTS TABLE
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  file_size integer,
  mime_type text,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 8. EMPLOYEE ID SEQUENCE
CREATE TABLE IF NOT EXISTS public.employee_id_sequence (
  id integer PRIMARY KEY DEFAULT 1,
  last_val integer NOT NULL DEFAULT 9,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row_check CHECK (id = 1)
);

INSERT INTO public.employee_id_sequence (id, last_val)
VALUES (1, 9)
ON CONFLICT (id) DO UPDATE SET last_val = GREATEST(public.employee_id_sequence.last_val, 9);

CREATE OR REPLACE FUNCTION public.claim_next_employee_id()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  next_num integer;
BEGIN
  SELECT last_val + 1 INTO next_num FROM public.employee_id_sequence WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.employee_id_sequence (id, last_val) VALUES (1, 10);
    next_num := 10;
  ELSE
    UPDATE public.employee_id_sequence SET last_val = next_num, updated_at = now() WHERE id = 1;
  END IF;
  RETURN 'TAS-' || lpad(next_num::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.peek_next_employee_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'TAS-' || lpad((COALESCE(MAX(last_val), 9) + 1)::text, 3, '0') FROM public.employee_id_sequence WHERE id = 1;
$$;

-- 9. INVITATIONS TABLE
CREATE TABLE IF NOT EXISTS public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL DEFAULT 'employee',
  category text NOT NULL DEFAULT 'full_time',
  designation text,
  department_id uuid REFERENCES public.departments(id),
  reporting_lead_id uuid REFERENCES public.profiles(id),
  status text NOT NULL DEFAULT 'queued',
  source text DEFAULT 'manual',
  batch_id uuid,
  attempts integer DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);

CREATE OR REPLACE FUNCTION public.claim_invitations(_limit int)
RETURNS SETOF public.invitations LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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

-- 10. JOB LEASES
CREATE TABLE IF NOT EXISTS public.job_leases (
  job_name text PRIMARY KEY,
  locked_until timestamptz NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  paused boolean NOT NULL DEFAULT false,
  pause_reason text
);

CREATE OR REPLACE FUNCTION public.acquire_job_lease(_job_name text, _seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  now_ts timestamptz := now();
BEGIN
  INSERT INTO public.job_leases (job_name, locked_until, locked_at)
  VALUES (_job_name, now_ts + (_seconds || ' seconds')::interval, now_ts)
  ON CONFLICT (job_name) DO UPDATE
    SET locked_until = now_ts + (_seconds || ' seconds')::interval, locked_at = now_ts
    WHERE public.job_leases.locked_until < now_ts;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_lease(_job_name text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.job_leases SET locked_until = now() WHERE job_name = _job_name;
$$;

-- 11. AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 12. PROJECTS & ALLOCATIONS
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  client_name text,
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  project_lead_id uuid REFERENCES public.profiles(id),
  work_mode text NOT NULL DEFAULT 'remote',
  shift text,
  task_unit text NOT NULL DEFAULT 'task',
  hourly_task_target numeric,
  daily_task_target numeric,
  quality_target_pct numeric,
  max_rejection_rate_pct numeric,
  required_headcount integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.project_team_leads (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, lead_id)
);

CREATE TABLE IF NOT EXISTS public.project_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reporting_lead_id uuid REFERENCES public.profiles(id),
  role_in_project text,
  start_date date NOT NULL DEFAULT current_date,
  end_date date,
  hours_per_day numeric NOT NULL DEFAULT 8,
  allocation_pct numeric NOT NULL DEFAULT 100,
  daily_task_target numeric,
  quality_target_pct numeric,
  max_rejection_rate_pct numeric,
  status text NOT NULL DEFAULT 'active',
  acknowledged_at timestamptz DEFAULT now(),
  acknowledged_by uuid REFERENCES public.profiles(id),
  acknowledgment_note text,
  over_allocation_override boolean NOT NULL DEFAULT false,
  allocated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 13. ATTENDANCE & WORK LOGGING
CREATE TABLE IF NOT EXISTS public.office_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  latitude numeric(10, 7) NOT NULL,
  longitude numeric(10, 7) NOT NULL,
  radius_meters integer NOT NULL DEFAULT 150,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, is_active)
VALUES ('Hyderabad HQ', 'Hitec City, Hyderabad, Telangana, India', 17.448293, 78.374246, 200, true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  source text NOT NULL DEFAULT 'biometric',
  record_count integer NOT NULL DEFAULT 0,
  imported_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date date NOT NULL DEFAULT current_date,
  check_in timestamptz NOT NULL DEFAULT now(),
  check_out timestamptz,
  work_mode text NOT NULL DEFAULT 'remote',
  late_reason text,
  status text NOT NULL DEFAULT 'present',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS public.attendance_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  work_mode public.attendance_work_mode NOT NULL DEFAULT 'wfo',
  exception_type public.day_exception NOT NULL DEFAULT 'none',
  exception_note text,
  required_minutes integer NOT NULL DEFAULT 480,
  check_in_at timestamptz,
  check_out_at timestamptz,
  check_in_device jsonb NOT NULL DEFAULT '{}'::jsonb,
  check_out_device jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'web',
  import_batch_id uuid REFERENCES public.import_batches(id),
  late_reason text,
  office_location_id uuid REFERENCES public.office_locations(id),
  location_status text NOT NULL DEFAULT 'not_applicable',
  location_latitude numeric(10, 7),
  location_longitude numeric(10, 7),
  location_accuracy_m numeric(8, 2),
  location_distance_m numeric(8, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)
);

CREATE TABLE IF NOT EXISTS public.attendance_punches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  punch_type text NOT NULL,
  punched_at timestamptz NOT NULL DEFAULT now(),
  device_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id uuid REFERENCES public.attendance(id) ON DELETE CASCADE,
  day_id uuid REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  category text NOT NULL,
  start_time timestamptz NOT NULL DEFAULT now(),
  end_time timestamptz,
  note text
);

CREATE TABLE IF NOT EXISTS public.work_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL DEFAULT now(),
  end_at timestamptz,
  duration_minutes integer,
  is_manual_override boolean NOT NULL DEFAULT false,
  override_reason text,
  override_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.blockers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id),
  day_id uuid REFERENCES public.attendance_days(id),
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  description text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text
);

CREATE TABLE IF NOT EXISTS public.hourly_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id),
  slot_date date NOT NULL DEFAULT current_date,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  slot_type text NOT NULL DEFAULT 'fixed',
  activity_type text NOT NULL DEFAULT 'annotation',
  description text NOT NULL,
  units_completed integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.task_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  allocation_id uuid REFERENCES public.project_allocations(id),
  slot_type public.task_slot_type NOT NULL DEFAULT 'fixed',
  slot_index integer,
  start_time time NOT NULL,
  end_time time NOT NULL,
  task_type text NOT NULL,
  description text NOT NULL,
  units_completed numeric NOT NULL DEFAULT 0,
  units_assigned numeric,
  status public.task_entry_status NOT NULL DEFAULT 'draft',
  reviewer_id uuid REFERENCES public.profiles(id),
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.eod_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day_id uuid REFERENCES public.attendance_days(id),
  project_id uuid REFERENCES public.projects(id),
  date date NOT NULL DEFAULT current_date,
  summary text NOT NULL,
  total_units integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  score numeric,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.daily_work_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  summary text NOT NULL,
  score numeric,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 14. LEAVES & REQUESTS
CREATE TABLE IF NOT EXISTS public.leave_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  yearly_allowance numeric NOT NULL DEFAULT 12,
  is_carry_forward boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leave_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
  year integer NOT NULL,
  total_accrued numeric NOT NULL DEFAULT 0,
  used numeric NOT NULL DEFAULT 0,
  pending numeric NOT NULL DEFAULT 0,
  carried_forward numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS public.leaves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leave_type text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  days_count numeric NOT NULL DEFAULT 1,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  applied_at timestamptz NOT NULL DEFAULT now(),
  action_by uuid REFERENCES public.profiles(id),
  action_at timestamptz,
  action_note text
);

CREATE TABLE IF NOT EXISTS public.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  current_tier text NOT NULL DEFAULT 'lead',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.request_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  tier text NOT NULL,
  approver_id uuid REFERENCES public.profiles(id),
  decision text NOT NULL DEFAULT 'pending',
  comment text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES public.leave_types(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  days_count numeric NOT NULL DEFAULT 1,
  reason text NOT NULL,
  status public.attendance_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  date date NOT NULL UNIQUE,
  work_location text,
  is_optional boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shift_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  grace_period_minutes integer NOT NULL DEFAULT 15,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 15. ANNOUNCEMENTS & AUTOMATION
CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL DEFAULT 'all',
  published boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_settings (
  id text PRIMARY KEY DEFAULT 'default',
  eod_cutoff_time time NOT NULL DEFAULT '22:00:00',
  auto_absent_cutoff_time time NOT NULL DEFAULT '12:00:00',
  flag_idle_break_minutes integer NOT NULL DEFAULT 60,
  flag_low_output_pct numeric NOT NULL DEFAULT 60,
  flag_high_rejection_pct numeric NOT NULL DEFAULT 20,
  escalation_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.automation_settings (id) VALUES ('default') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  rule_type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  records_processed integer NOT NULL DEFAULT 0,
  flags_raised integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.automation_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  day_id uuid REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  rule text NOT NULL,
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 16. HELPER FUNCTIONS
CREATE OR REPLACE FUNCTION public.profile_names(_ids uuid[])
RETURNS TABLE(id uuid, full_name text, employee_code text, photo_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, COALESCE(p.full_name, p.display_name, 'Unknown') as full_name, p.employee_code, p.photo_url
  FROM public.profiles p
  WHERE p.id = ANY(_ids);
$$;

CREATE OR REPLACE FUNCTION public.day_targets(_day_id uuid)
RETURNS TABLE(target_units numeric, target_quality numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 
    COALESCE(SUM(pa.daily_task_target), 0) as target_units,
    COALESCE(AVG(pa.quality_target_pct), 95.0) as target_quality
  FROM public.attendance_days ad
  JOIN public.project_allocations pa ON pa.user_id = ad.user_id AND pa.status = 'active'
  WHERE ad.id = _day_id;
$$;

CREATE OR REPLACE FUNCTION public.attendance_day_metrics(_day_id uuid)
RETURNS TABLE(
  total_work_minutes integer,
  total_break_minutes integer,
  completed_units numeric,
  pending_tasks integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE((SELECT SUM(duration_minutes) FROM public.work_sessions WHERE day_id = _day_id), 0)::integer as total_work_minutes,
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time))/60) FROM public.breaks WHERE day_id = _day_id), 0)::integer as total_break_minutes,
    COALESCE((SELECT SUM(units_completed) FROM public.task_entries WHERE day_id = _day_id), 0) as completed_units,
    COALESCE((SELECT COUNT(*) FROM public.task_entries WHERE day_id = _day_id AND status = 'draft'), 0)::integer as pending_tasks;
$$;

-- Automatic profile creation on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_next_code text;
  v_role text := 'employee';
  v_category public.user_category := 'full_time';
  v_name text;
BEGIN
  -- Check for existing invitation
  SELECT role, category::public.user_category, full_name
  INTO v_role, v_category, v_name
  FROM public.invitations
  WHERE lower(email) = lower(new.email) AND status IN ('queued', 'sent')
  ORDER BY created_at DESC LIMIT 1;

  v_next_code := public.claim_next_employee_id();

  INSERT INTO public.profiles (
    id,
    work_email,
    full_name,
    display_name,
    category,
    account_status,
    employee_code
  ) VALUES (
    new.id,
    new.email,
    COALESCE(v_name, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    COALESCE(v_name, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    COALESCE(v_category, 'full_time'),
    'active',
    v_next_code
  ) ON CONFLICT (id) DO UPDATE SET
    work_email = EXCLUDED.work_email,
    employee_code = COALESCE(public.profiles.employee_code, EXCLUDED.employee_code);

  -- Assign user role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (new.id, COALESCE(v_role, 'employee'))
  ON CONFLICT (user_id, role) DO NOTHING;

  -- Mark invitation accepted if found
  UPDATE public.invitations
  SET status = 'accepted', updated_at = now()
  WHERE lower(email) = lower(new.email);

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 17. SEED DATA (ROLES & PERMISSIONS)
INSERT INTO public.roles (role, label, rank, description) VALUES
  ('super_admin', 'Super Admin', 100, 'Unrestricted access across all organizations and modules'),
  ('founder', 'Founder / Executive', 90, 'Executive oversight, strategic metrics, approvals'),
  ('hr', 'HR Manager', 70, 'Workforce lifecycle, onboarding, leave/attendance governance'),
  ('admin', 'Operations Admin', 60, 'Operational governance and batch processing'),
  ('lead', 'Project / Team Lead', 50, 'Team allocations, daily reviews, blocker resolution'),
  ('employee', 'Employee / Contributor', 10, 'Self-service portal, daily work logging, leave requests')
ON CONFLICT (role) DO UPDATE SET label = EXCLUDED.label, rank = EXCLUDED.rank;

INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('workforce:read:all', 'workforce', 'read', 'all', 'View complete employee directory'),
  ('workforce:create:all', 'workforce', 'create', 'all', 'Create employee profiles'),
  ('workforce:update:all', 'workforce', 'update', 'all', 'Update employee profiles'),
  ('workforce:delete:all', 'workforce', 'delete', 'all', 'Deactivate or delete profiles'),
  ('invitations:create:all', 'invitations', 'create', 'all', 'Send invites to new employees'),
  ('invitations:read:all', 'invitations', 'read', 'all', 'View sent invitations'),
  ('documents:read:all', 'documents', 'read', 'all', 'View employee submitted documents'),
  ('documents:verify:all', 'documents', 'verify', 'all', 'Approve/reject documents'),
  ('projects:manage:all', 'projects', 'manage', 'all', 'Create and manage projects and allocations'),
  ('attendance:read:all', 'attendance', 'read', 'all', 'View workforce attendance'),
  ('attendance:manage:all', 'attendance', 'manage', 'all', 'Manage attendance exceptions'),
  ('eod:read:all', 'eod', 'read', 'all', 'View submitted EOD reports'),
  ('eod:review:all', 'eod', 'review', 'all', 'Review and grade EOD reports'),
  ('requests:read:all', 'requests', 'read', 'all', 'View leave and work requests'),
  ('requests:approve:all', 'requests', 'approve', 'all', 'Approve or reject leave/work requests'),
  ('announcements:manage:all', 'announcements', 'manage', 'all', 'Publish company announcements'),
  ('audit:read:all', 'audit', 'read', 'all', 'View platform audit logs')
ON CONFLICT (key) DO NOTHING;

-- Assign all permissions to super_admin, founder, and hr
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'super_admin', key FROM public.permissions
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT 'founder', key FROM public.permissions
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT 'hr', key FROM public.permissions
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT 'admin', key FROM public.permissions WHERE key NOT IN ('workforce:delete:all')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT 'lead', key FROM public.permissions WHERE key IN ('workforce:read:all', 'projects:manage:all', 'attendance:read:all', 'eod:read:all', 'eod:review:all', 'requests:read:all', 'requests:approve:all')
ON CONFLICT DO NOTHING;

-- Seed default departments
INSERT INTO public.departments (name, code) VALUES
  ('Operations', 'OPS'),
  ('Engineering & AI', 'ENG'),
  ('Human Resources', 'HR'),
  ('Delivery', 'DEL'),
  ('Quality Assurance', 'QA')
ON CONFLICT (code) DO NOTHING;

-- 18. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_team_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hourly_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eod_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_work_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Profiles
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_permission(auth.uid(), 'workforce:update:all'))
  WITH CHECK (id = auth.uid() OR public.has_permission(auth.uid(), 'workforce:update:all'));

DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (true);

-- User roles & RBAC
DROP POLICY IF EXISTS "user_roles_select" ON public.user_roles;
CREATE POLICY "user_roles_select" ON public.user_roles FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "user_roles_manage" ON public.user_roles;
CREATE POLICY "user_roles_manage" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'workforce:update:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'workforce:update:all'));

DROP POLICY IF EXISTS "roles_select" ON public.roles;
CREATE POLICY "roles_select" ON public.roles FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "permissions_select" ON public.permissions;
CREATE POLICY "permissions_select" ON public.permissions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "role_permissions_select" ON public.role_permissions;
CREATE POLICY "role_permissions_select" ON public.role_permissions FOR SELECT TO authenticated USING (true);

-- Departments
DROP POLICY IF EXISTS "departments_select" ON public.departments;
CREATE POLICY "departments_select" ON public.departments FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "departments_manage" ON public.departments;
CREATE POLICY "departments_manage" ON public.departments FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'workforce:update:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'workforce:update:all'));

-- Invitations
DROP POLICY IF EXISTS "invitations_all" ON public.invitations;
CREATE POLICY "invitations_all" ON public.invitations FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- Documents
DROP POLICY IF EXISTS "documents_all" ON public.documents;
CREATE POLICY "documents_all" ON public.documents FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'documents:read:all'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'documents:verify:all'));

-- Projects & Allocations
DROP POLICY IF EXISTS "projects_all" ON public.projects;
CREATE POLICY "projects_all" ON public.projects FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "project_team_leads_all" ON public.project_team_leads;
CREATE POLICY "project_team_leads_all" ON public.project_team_leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "project_allocations_all" ON public.project_allocations;
CREATE POLICY "project_allocations_all" ON public.project_allocations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Attendance & Work Tracking
DROP POLICY IF EXISTS "attendance_all" ON public.attendance;
CREATE POLICY "attendance_all" ON public.attendance FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "attendance_days_all" ON public.attendance_days;
CREATE POLICY "attendance_days_all" ON public.attendance_days FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "attendance_punches_all" ON public.attendance_punches;
CREATE POLICY "attendance_punches_all" ON public.attendance_punches FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "work_sessions_all" ON public.work_sessions;
CREATE POLICY "work_sessions_all" ON public.work_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "breaks_all" ON public.breaks;
CREATE POLICY "breaks_all" ON public.breaks FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "blockers_all" ON public.blockers;
CREATE POLICY "blockers_all" ON public.blockers FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "hourly_tasks_all" ON public.hourly_tasks;
CREATE POLICY "hourly_tasks_all" ON public.hourly_tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "task_entries_all" ON public.task_entries;
CREATE POLICY "task_entries_all" ON public.task_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "eod_reports_all" ON public.eod_reports;
CREATE POLICY "eod_reports_all" ON public.eod_reports FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "daily_work_logs_all" ON public.daily_work_logs;
CREATE POLICY "daily_work_logs_all" ON public.daily_work_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Leaves & Requests
DROP POLICY IF EXISTS "leave_types_select" ON public.leave_types;
CREATE POLICY "leave_types_select" ON public.leave_types FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "leave_balances_all" ON public.leave_balances;
CREATE POLICY "leave_balances_all" ON public.leave_balances FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "leaves_all" ON public.leaves;
CREATE POLICY "leaves_all" ON public.leaves FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "leave_requests_all" ON public.leave_requests;
CREATE POLICY "leave_requests_all" ON public.leave_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "requests_all" ON public.requests;
CREATE POLICY "requests_all" ON public.requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "request_approvals_all" ON public.request_approvals;
CREATE POLICY "request_approvals_all" ON public.request_approvals FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "holidays_all" ON public.holidays;
CREATE POLICY "holidays_all" ON public.holidays FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "shift_schedules_all" ON public.shift_schedules;
CREATE POLICY "shift_schedules_all" ON public.shift_schedules FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Announcements & Automation
DROP POLICY IF EXISTS "announcements_all" ON public.announcements;
CREATE POLICY "announcements_all" ON public.announcements FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "automation_settings_all" ON public.automation_settings;
CREATE POLICY "automation_settings_all" ON public.automation_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "automation_rules_all" ON public.automation_rules;
CREATE POLICY "automation_rules_all" ON public.automation_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "automation_runs_all" ON public.automation_runs;
CREATE POLICY "automation_runs_all" ON public.automation_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "automation_flags_all" ON public.automation_flags;
CREATE POLICY "automation_flags_all" ON public.automation_flags FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "office_locations_all" ON public.office_locations;
CREATE POLICY "office_locations_all" ON public.office_locations FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "import_batches_all" ON public.import_batches;
CREATE POLICY "import_batches_all" ON public.import_batches FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
CREATE POLICY "audit_logs_all" ON public.audit_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 19. STORAGE BUCKETS (avatars & documents)
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies
DROP POLICY IF EXISTS "Allow authenticated read avatars" ON storage.objects;
CREATE POLICY "Allow authenticated read avatars" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Allow authenticated upload avatars" ON storage.objects;
CREATE POLICY "Allow authenticated upload avatars" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Allow users to read own documents" ON storage.objects;
CREATE POLICY "Allow users to read own documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents');

DROP POLICY IF EXISTS "Allow users to upload documents" ON storage.objects;
CREATE POLICY "Allow users to upload documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents');

-- ==============================================================================
-- DONE!
-- ==============================================================================
