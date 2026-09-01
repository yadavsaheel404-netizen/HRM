-- ==============================================================================
-- The AI School HRM Portal: Complete Database Schema Initialization
-- ==============================================================================

-- 1. Create Enums if not exists
DO $$ BEGIN
  CREATE TYPE public.user_category AS ENUM ('full_time', 'intern', 'freelancer', 'trainer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.account_status AS ENUM ('invited', 'activated', 'profile_pending', 'under_verification', 'active', 'deactivated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.employment_status AS ENUM ('active', 'resigned', 'terminated', 'on_leave', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Relax legacy NOT NULL constraints on profiles
ALTER TABLE public.profiles ALTER COLUMN display_name DROP NOT NULL;

-- 3. Ensure role column in user_roles supports all role strings
ALTER TABLE public.user_roles ALTER COLUMN role TYPE text;

-- 4. Ensure HRM columns exist on profiles table
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS work_email text,
  ADD COLUMN IF NOT EXISTS personal_email text,
  ADD COLUMN IF NOT EXISTS mobile text,
  ADD COLUMN IF NOT EXISTS category public.user_category DEFAULT 'full_time',
  ADD COLUMN IF NOT EXISTS designation text,
  ADD COLUMN IF NOT EXISTS department_id uuid,
  ADD COLUMN IF NOT EXISTS reporting_lead_id uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS joining_date date,
  ADD COLUMN IF NOT EXISTS last_working_day date,
  ADD COLUMN IF NOT EXISTS work_location text DEFAULT 'hyderabad',
  ADD COLUMN IF NOT EXISTS account_status public.account_status DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS employment_status public.employment_status DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS employee_code text,
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS current_address text,
  ADD COLUMN IF NOT EXISTS permanent_address text,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
  ADD COLUMN IF NOT EXISTS skills text[],
  ADD COLUMN IF NOT EXISTS experience_years numeric,
  ADD COLUMN IF NOT EXISTS institution text,
  ADD COLUMN IF NOT EXISTS internship_start date,
  ADD COLUMN IF NOT EXISTS internship_end date,
  ADD COLUMN IF NOT EXISTS available_hours_per_day numeric DEFAULT 8,
  ADD COLUMN IF NOT EXISTS profile_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_assignment boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS must_change_password boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz;

-- 5. Departments Table
CREATE TABLE IF NOT EXISTS public.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  lead_id uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.departments (name, code)
VALUES 
  ('Operations', 'OPS'),
  ('Engineering & AI', 'ENG'),
  ('Human Resources', 'HR'),
  ('Delivery', 'DEL')
ON CONFLICT (code) DO NOTHING;

-- 6. Documents Table
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 7. Employee ID Sequence Table
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
  UPDATE public.employee_id_sequence SET last_val = next_num, updated_at = now() WHERE id = 1;
  RETURN 'TAS-' || lpad(next_num::text, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.peek_next_employee_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'TAS-' || lpad((COALESCE(last_val, 0) + 1)::text, 3, '0') FROM public.employee_id_sequence WHERE id = 1;
$$;

-- 8. Invitations Table
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

-- 9. Job Leases Table
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

-- 10. Audit Logs Table
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

-- 11. Projects & Allocations
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

-- 12. Attendance, Breaks, Blockers, Tasks & EOD Reports
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

CREATE TABLE IF NOT EXISTS public.breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id uuid NOT NULL REFERENCES public.attendance(id) ON DELETE CASCADE,
  category text NOT NULL,
  start_time timestamptz NOT NULL DEFAULT now(),
  end_time timestamptz,
  note text
);

CREATE TABLE IF NOT EXISTS public.blockers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id),
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

CREATE TABLE IF NOT EXISTS public.eod_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  report_date date NOT NULL DEFAULT current_date,
  hours_attended numeric DEFAULT 8,
  task_time_minutes integer DEFAULT 0,
  break_time_minutes integer DEFAULT 0,
  blocked_time_minutes integer DEFAULT 0,
  uncovered_minutes integer DEFAULT 0,
  units_completed integer DEFAULT 0,
  target_achievement_pct numeric DEFAULT 100,
  completed_tasks text,
  plan_tomorrow text,
  challenges text,
  support_needed text,
  status text NOT NULL DEFAULT 'submitted',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, report_date)
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
  lead_approved_at timestamptz,
  lead_approved_by uuid REFERENCES public.profiles(id),
  hr_approved_at timestamptz,
  hr_approved_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  published boolean NOT NULL DEFAULT true,
  author_id uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.office_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  city text NOT NULL,
  country text NOT NULL DEFAULT 'India',
  address text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 13. System Security & Permission Helper Functions
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('super_admin', 'founder', 'admin')) THEN
    RETURN true;
  ELSIF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'hr') THEN
    RETURN _permission IN (
      'workforce:read:self','workforce:read:all','workforce:create:all','workforce:update:all','documents:read:all','documents:verify:all',
      'invitations:read:all','invitations:create:all','org:manage:all','audit:read:all','projects:read:all','allocations:read:all',
      'allocations:acknowledge:self','attendance:log:self','attendance:read:all','tasks:log:self','tasks:read:all',
      'eod:submit:self','eod:read:all','requests:submit:self','requests:read:all','requests:approve:hr','announcements:read:all'
    );
  ELSIF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'lead') THEN
    RETURN _permission IN (
      'workforce:read:self','workforce:read:team','documents:read:team','projects:read:team','allocations:read:team',
      'allocations:acknowledge:self','attendance:log:self','attendance:read:team','tasks:log:self','tasks:read:team',
      'tasks:review:team','blockers:raise:self','blockers:manage:team','eod:submit:self','eod:read:team','eod:review:team',
      'requests:submit:self','requests:read:team','requests:approve:lead','announcements:read:all','analytics:read:team'
    );
  ELSE
    RETURN _permission IN (
      'workforce:read:self','documents:read:self','documents:upload:self','allocations:acknowledge:self',
      'attendance:log:self','attendance:read:self','tasks:log:self','blockers:raise:self','eod:submit:self',
      'requests:submit:self','requests:read:self','announcements:read:all'
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.profile_names(_ids uuid[])
RETURNS TABLE (id uuid, full_name text, designation text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, COALESCE(p.full_name, p.display_name, ''), p.designation
  FROM public.profiles p
  WHERE p.id = ANY(_ids);
$$;

CREATE OR REPLACE FUNCTION public.can_log_work(_user_id uuid, _project_id uuid DEFAULT NULL, _on_date date DEFAULT CURRENT_DATE)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true;
$$;

CREATE OR REPLACE FUNCTION public.allocation_pct_used(_user_id uuid, _date date DEFAULT CURRENT_DATE)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(allocation_pct), 0)
  FROM public.project_allocations
  WHERE user_id = _user_id AND status <> 'ended' AND start_date <= _date AND (end_date IS NULL OR end_date >= _date);
$$;

-- 14. Grants
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;

-- 15. Sync Profiles & Roles for the 9 Accounts
DO $$
DECLARE
  u record;
BEGIN
  FOR u IN SELECT id, email FROM auth.users LOOP
    INSERT INTO public.profiles (id, display_name, email, work_email, full_name, account_status, employment_status)
    VALUES (u.id, split_part(u.email, '@', 1), u.email, u.email, split_part(u.email, '@', 1), 'active', 'active')
    ON CONFLICT (id) DO UPDATE SET 
      display_name = COALESCE(public.profiles.display_name, EXCLUDED.display_name),
      email = COALESCE(public.profiles.email, EXCLUDED.email),
      work_email = EXCLUDED.work_email,
      account_status = 'active',
      employment_status = 'active';

    IF u.email = 'saheelyadav67@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'Saheel Yadav', display_name = 'Saheel Yadav', category = 'full_time', designation = 'Super Administrator', employee_code = 'TAS-001' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'super_admin') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'adityakanchi@proton.me' THEN
      UPDATE public.profiles SET full_name = 'Aditya Kanchi', display_name = 'Aditya Kanchi', category = 'full_time', designation = 'Founder & CEO', employee_code = 'TAS-002' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'founder') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'hr.theaischool@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'HR Operations', display_name = 'HR Operations', category = 'full_time', designation = 'HR Manager', employee_code = 'TAS-003' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'hr') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'nikithasambangi1@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'Nikitha Sambangi', display_name = 'Nikitha Sambangi', category = 'full_time', designation = 'Operations Admin', employee_code = 'TAS-004' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'admin') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'adikanchi20@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'Aditya Lead', display_name = 'Aditya Lead', category = 'full_time', designation = 'Program Lead', employee_code = 'TAS-005' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'lead') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'saheelyadav06@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'Saheel (Full-Time)', display_name = 'Saheel (Full-Time)', category = 'full_time', designation = 'Full-Time Associate', employee_code = 'TAS-006' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'employee') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'nikithasambangi@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'Nikitha (Intern)', display_name = 'Nikitha (Intern)', category = 'intern', designation = 'AI Operations Intern', employee_code = 'TAS-007' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'employee') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'yadavsaheel404@gmail.com' THEN
      UPDATE public.profiles SET full_name = 'Saheel (Freelancer)', display_name = 'Saheel (Freelancer)', category = 'freelancer', designation = 'Specialist Freelancer', employee_code = 'TAS-008' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'employee') ON CONFLICT DO NOTHING;
    ELSIF u.email = 'solo@sp33d.space' THEN
      UPDATE public.profiles SET full_name = 'Solo Trainer', display_name = 'Solo Trainer', category = 'trainer', designation = 'Senior Technical Trainer', employee_code = 'TAS-009' WHERE id = u.id;
      INSERT INTO public.user_roles (user_id, role) VALUES (u.id, 'employee') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- 16. My Permissions Function
CREATE OR REPLACE FUNCTION public.my_permissions()
RETURNS TABLE (permission_key text) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('super_admin', 'founder', 'admin')) THEN
    RETURN QUERY SELECT unnest(ARRAY[
      'workforce:read:self','workforce:read:team','workforce:read:all','workforce:create:all','workforce:update:all','workforce:deactivate:all',
      'documents:read:self','documents:read:team','documents:read:all','documents:upload:self','documents:verify:all',
      'invitations:read:all','invitations:create:all','rbac:manage:all','rbac:assign:all','org:manage:all','audit:read:all',
      'projects:read:all','projects:read:team','projects:manage:all','allocations:read:all','allocations:read:team','allocations:manage:all',
      'allocations:acknowledge:self','attendance:log:self','attendance:read:self','attendance:read:team','attendance:read:all',
      'tasks:log:self','tasks:read:team','tasks:read:all','tasks:review:team','blockers:raise:self','blockers:manage:team',
      'eod:submit:self','eod:read:team','eod:read:all','eod:review:team','requests:submit:self','requests:read:self','requests:read:team',
      'requests:read:all','requests:approve:lead','requests:approve:hr','announcements:read:all','announcements:manage:all',
      'analytics:read:team','analytics:read:all','automation:run:all','import:manage:all'
    ]::text[]);
  ELSIF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'hr') THEN
    RETURN QUERY SELECT unnest(ARRAY[
      'workforce:read:self','workforce:read:all','workforce:create:all','workforce:update:all','documents:read:all','documents:verify:all',
      'invitations:read:all','invitations:create:all','org:manage:all','audit:read:all','projects:read:all','allocations:read:all',
      'allocations:acknowledge:self','attendance:log:self','attendance:read:all','tasks:log:self','tasks:read:all',
      'eod:submit:self','eod:read:all','requests:submit:self','requests:read:all','requests:approve:hr','announcements:read:all'
    ]::text[]);
  ELSIF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'lead') THEN
    RETURN QUERY SELECT unnest(ARRAY[
      'workforce:read:self','workforce:read:team','documents:read:team','projects:read:team','allocations:read:team',
      'allocations:acknowledge:self','attendance:log:self','attendance:read:team','tasks:log:self','tasks:read:team',
      'tasks:review:team','blockers:raise:self','blockers:manage:team','eod:submit:self','eod:read:team','eod:review:team',
      'requests:submit:self','requests:read:team','requests:approve:lead','announcements:read:all','analytics:read:team'
    ]::text[]);
  ELSE
    RETURN QUERY SELECT unnest(ARRAY[
      'workforce:read:self','documents:read:self','documents:upload:self','allocations:acknowledge:self',
      'attendance:log:self','attendance:read:self','tasks:log:self','blockers:raise:self','eod:submit:self',
      'requests:submit:self','requests:read:self','announcements:read:all'
    ]::text[]);
  END IF;
END;
$$;
