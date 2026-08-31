-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('super_admin','founder','hr','admin','lead','employee');
CREATE TYPE public.user_category AS ENUM ('full_time','intern','freelancer','trainer');
CREATE TYPE public.account_status AS ENUM ('invited','activated','profile_pending','under_verification','active');
CREATE TYPE public.employment_status AS ENUM ('active','inactive','on_hold','exited');
CREATE TYPE public.document_type AS ENUM ('resume','identity_proof','pan','bank_details','education','offer_letter','nda','other');
CREATE TYPE public.document_status AS ENUM ('pending','verified','rejected');
CREATE TYPE public.invitation_status AS ENUM ('queued','sending','sent','failed','accepted','revoked');

-- ============ UTIL ============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ============ DEPARTMENTS ============
CREATE TABLE public.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  work_email text NOT NULL UNIQUE,
  personal_email text,
  mobile text,
  category public.user_category NOT NULL,
  designation text,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  reporting_lead_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  joining_date date,
  last_working_day date,
  work_location text,
  account_status public.account_status NOT NULL DEFAULT 'invited',
  employment_status public.employment_status NOT NULL DEFAULT 'active',
  employee_code text UNIQUE,
  photo_url text,
  date_of_birth date,
  current_address text,
  permanent_address text,
  emergency_contact_name text,
  emergency_contact_phone text,
  skills text[],
  experience_years numeric(4,1),
  institution text,
  internship_start date,
  internship_end date,
  available_hours_per_day numeric(4,1),
  profile_submitted_at timestamptz,
  profile_verified_at timestamptz,
  profile_verified_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  needs_assignment boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_profiles_reporting_lead ON public.profiles(reporting_lead_id);
CREATE INDEX idx_profiles_department ON public.profiles(department_id);

-- ============ RBAC ============
CREATE TABLE public.permissions (
  key text PRIMARY KEY,
  resource text NOT NULL,
  action text NOT NULL,
  scope text NOT NULL,
  description text NOT NULL
);

CREATE TABLE public.roles (
  role public.app_role PRIMARY KEY,
  label text NOT NULL,
  rank int NOT NULL,
  description text
);

CREATE TABLE public.role_permissions (
  role public.app_role NOT NULL REFERENCES public.roles(role) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_key)
);

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- ============ DOCUMENTS ============
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  doc_type public.document_type NOT NULL,
  file_path text NOT NULL,
  file_name text NOT NULL,
  status public.document_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_user ON public.documents(user_id);

-- ============ INVITATIONS ============
CREATE TABLE public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  purpose text NOT NULL DEFAULT 'onboarding',
  full_name text NOT NULL,
  token_hash text NOT NULL,
  status public.invitation_status NOT NULL DEFAULT 'queued',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  accepted_at timestamptz,
  invited_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_invitations_email_purpose_open ON public.invitations(lower(email), purpose)
  WHERE status IN ('queued','sending','sent');
CREATE INDEX idx_invitations_status ON public.invitations(status);

CREATE TABLE public.job_leases (
  job_name text PRIMARY KEY,
  locked_until timestamptz NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  paused boolean NOT NULL DEFAULT false,
  pause_reason text
);

-- ============ AUDIT LOG ============
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON public.audit_logs(created_at DESC);

-- ============ SECURITY DEFINER HELPERS ============
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = _user_id
      AND rp.permission_key = _permission
  );
$$;

CREATE OR REPLACE FUNCTION public.is_reporting_lead_of(_lead_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND reporting_lead_id = _lead_id);
$$;

-- ============ GRANTS ============
GRANT SELECT ON public.departments TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.departments TO authenticated;
GRANT ALL ON public.departments TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

GRANT SELECT ON public.permissions TO authenticated;
GRANT ALL ON public.permissions TO service_role;

GRANT SELECT ON public.roles TO authenticated;
GRANT ALL ON public.roles TO service_role;

GRANT SELECT, INSERT, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;

GRANT SELECT, INSERT, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;

GRANT SELECT ON public.invitations TO authenticated;
GRANT ALL ON public.invitations TO service_role;

GRANT ALL ON public.job_leases TO service_role;

GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;

-- ============ RLS ============
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- departments
CREATE POLICY departments_read ON public.departments FOR SELECT TO authenticated USING (true);
CREATE POLICY departments_write ON public.departments FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'org:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'org:manage:all'));

-- profiles: self / team lead / org-wide readers
CREATE POLICY profiles_select_self ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY profiles_select_team ON public.profiles FOR SELECT TO authenticated
  USING (reporting_lead_id = auth.uid() AND public.has_permission(auth.uid(), 'workforce:read:team'));
CREATE POLICY profiles_select_all ON public.profiles FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'workforce:read:all'));
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY profiles_update_all ON public.profiles FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'workforce:update:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'workforce:update:all'));
CREATE POLICY profiles_insert_all ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'workforce:create:all'));

-- permission catalogue
CREATE POLICY permissions_read ON public.permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY roles_read ON public.roles FOR SELECT TO authenticated USING (true);
CREATE POLICY role_permissions_read ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY role_permissions_insert ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'rbac:manage:all'));
CREATE POLICY role_permissions_delete ON public.role_permissions FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'rbac:manage:all'));

-- user roles: read own, read all with permission; never self-grant
CREATE POLICY user_roles_select_self ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY user_roles_select_all ON public.user_roles FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'workforce:read:all'));
CREATE POLICY user_roles_insert ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'rbac:assign:all') AND user_id <> auth.uid());
CREATE POLICY user_roles_delete ON public.user_roles FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'rbac:assign:all') AND user_id <> auth.uid());

-- documents
CREATE POLICY documents_select_self ON public.documents FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY documents_select_team ON public.documents FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'documents:read:team')
     AND public.is_reporting_lead_of(auth.uid(), user_id));
CREATE POLICY documents_select_all ON public.documents FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'documents:read:all'));
CREATE POLICY documents_insert_self ON public.documents FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY documents_insert_all ON public.documents FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'documents:verify:all'));
CREATE POLICY documents_update_self ON public.documents FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status <> 'verified')
  WITH CHECK (user_id = auth.uid());
CREATE POLICY documents_update_verify ON public.documents FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'documents:verify:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'documents:verify:all'));
CREATE POLICY documents_delete_self ON public.documents FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND status <> 'verified');

-- invitations: readable by those who can manage workforce; writes server-side only
CREATE POLICY invitations_select ON public.invitations FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'invitations:read:all'));

-- audit logs: read-only for privileged roles, insert only via service role
CREATE POLICY audit_select ON public.audit_logs FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'audit:read:all'));

-- ============ TRIGGERS ============
CREATE TRIGGER trg_departments_updated BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_invitations_updated BEFORE UPDATE ON public.invitations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SEED: roles ============
INSERT INTO public.roles (role, label, rank, description) VALUES
  ('super_admin','Super Admin',1,'Full unrestricted access'),
  ('founder','Founder',2,'Organisation-wide read-only leadership view'),
  ('hr','HR',3,'Owns employee records, onboarding and verification'),
  ('admin','Admin',4,'Operational control: users, projects, reports'),
  ('lead','Project / Team Lead',5,'Manages their assigned team'),
  ('employee','Employee',6,'Daily workflow participant');

-- ============ SEED: permissions ============
INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('workforce:read:self','workforce','read','self','View own profile'),
  ('workforce:read:team','workforce','read','team','View direct reports'),
  ('workforce:read:all','workforce','read','all','View the whole workforce'),
  ('workforce:create:all','workforce','create','all','Create people records'),
  ('workforce:update:all','workforce','update','all','Edit any person record'),
  ('workforce:deactivate:all','workforce','deactivate','all','Change employment status'),
  ('documents:read:self','documents','read','self','View own documents'),
  ('documents:read:team','documents','read','team','View direct reports documents'),
  ('documents:read:all','documents','read','all','View all documents'),
  ('documents:upload:self','documents','upload','self','Upload own documents'),
  ('documents:verify:all','documents','verify','all','Verify or reject documents'),
  ('invitations:read:all','invitations','read','all','View the invitation queue'),
  ('invitations:create:all','invitations','create','all','Invite new people'),
  ('rbac:manage:all','rbac','manage','all','Edit the role/permission matrix'),
  ('rbac:assign:all','rbac','assign','all','Assign roles to people'),
  ('org:manage:all','org','manage','all','Manage departments and org settings'),
  ('audit:read:all','audit','read','all','View the audit log');

-- ============ SEED: role -> permission matrix ============
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'super_admin', key FROM public.permissions;

INSERT INTO public.role_permissions (role, permission_key) VALUES
  -- Founder: organisation-wide READ ONLY
  ('founder','workforce:read:self'),
  ('founder','workforce:read:team'),
  ('founder','workforce:read:all'),
  ('founder','documents:read:self'),
  ('founder','audit:read:all'),
  ('founder','invitations:read:all'),
  -- HR: owns people records
  ('hr','workforce:read:self'),
  ('hr','workforce:read:team'),
  ('hr','workforce:read:all'),
  ('hr','workforce:create:all'),
  ('hr','workforce:update:all'),
  ('hr','workforce:deactivate:all'),
  ('hr','documents:read:self'),
  ('hr','documents:read:team'),
  ('hr','documents:read:all'),
  ('hr','documents:upload:self'),
  ('hr','documents:verify:all'),
  ('hr','invitations:read:all'),
  ('hr','invitations:create:all'),
  ('hr','audit:read:all'),
  -- Admin: operations
  ('admin','workforce:read:self'),
  ('admin','workforce:read:team'),
  ('admin','workforce:read:all'),
  ('admin','workforce:create:all'),
  ('admin','workforce:update:all'),
  ('admin','workforce:deactivate:all'),
  ('admin','documents:read:self'),
  ('admin','documents:read:all'),
  ('admin','documents:upload:self'),
  ('admin','invitations:read:all'),
  ('admin','invitations:create:all'),
  ('admin','rbac:manage:all'),
  ('admin','rbac:assign:all'),
  ('admin','org:manage:all'),
  ('admin','audit:read:all'),
  -- Lead: their team
  ('lead','workforce:read:self'),
  ('lead','workforce:read:team'),
  ('lead','documents:read:self'),
  ('lead','documents:read:team'),
  ('lead','documents:upload:self'),
  -- Employee: self only
  ('employee','workforce:read:self'),
  ('employee','documents:read:self'),
  ('employee','documents:upload:self');

-- ============ SEED: departments ============
INSERT INTO public.departments (name, code, description) VALUES
  ('Operations','OPS','Client delivery operations'),
  ('Human Resources','HR','People and onboarding'),
  ('Engineering','ENG','Product and platform'),
  ('Training','TRN','Trainers and enablement');