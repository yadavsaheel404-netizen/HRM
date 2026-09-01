-- ==============================================================================
-- The AI School HRM Portal: RLS Security Policies
-- ==============================================================================

-- 1. Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blockers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hourly_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eod_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 2. Profiles Policies
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;

CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_permission(auth.uid(), 'workforce:update:all'))
  WITH CHECK (id = auth.uid() OR public.has_permission(auth.uid(), 'workforce:update:all'));

CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- 3. User Roles Policies
DROP POLICY IF EXISTS "user_roles_select" ON public.user_roles;
CREATE POLICY "user_roles_select" ON public.user_roles
  FOR SELECT TO authenticated
  USING (true);

-- 4. Departments Policies
DROP POLICY IF EXISTS "departments_select" ON public.departments;
CREATE POLICY "departments_select" ON public.departments
  FOR SELECT TO authenticated
  USING (true);

-- 5. Invitations Policies
DROP POLICY IF EXISTS "invitations_select" ON public.invitations;
DROP POLICY IF EXISTS "invitations_insert" ON public.invitations;
DROP POLICY IF EXISTS "invitations_update" ON public.invitations;
DROP POLICY IF EXISTS "invitations_delete" ON public.invitations;

CREATE POLICY "invitations_select" ON public.invitations
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'invitations:read:all') OR created_by = auth.uid());

CREATE POLICY "invitations_insert" ON public.invitations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'invitations:create:all') OR auth.uid() IS NOT NULL);

CREATE POLICY "invitations_update" ON public.invitations
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'invitations:create:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'invitations:create:all'));

CREATE POLICY "invitations_delete" ON public.invitations
  FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'invitations:create:all'));

-- 6. Documents Policies
DROP POLICY IF EXISTS "documents_all" ON public.documents;
CREATE POLICY "documents_all" ON public.documents
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'documents:read:all'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'documents:verify:all'));

-- 7. Projects & Allocations Policies
DROP POLICY IF EXISTS "projects_all" ON public.projects;
CREATE POLICY "projects_all" ON public.projects
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (public.has_permission(auth.uid(), 'projects:manage:all'));

DROP POLICY IF EXISTS "project_allocations_all" ON public.project_allocations;
CREATE POLICY "project_allocations_all" ON public.project_allocations
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- 8. Attendance & Work Tracking Policies
DROP POLICY IF EXISTS "attendance_all" ON public.attendance;
CREATE POLICY "attendance_all" ON public.attendance
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'attendance:read:all'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'attendance:read:all'));

DROP POLICY IF EXISTS "breaks_all" ON public.breaks;
CREATE POLICY "breaks_all" ON public.breaks
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "blockers_all" ON public.blockers;
CREATE POLICY "blockers_all" ON public.blockers
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "hourly_tasks_all" ON public.hourly_tasks;
CREATE POLICY "hourly_tasks_all" ON public.hourly_tasks
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "eod_reports_all" ON public.eod_reports;
CREATE POLICY "eod_reports_all" ON public.eod_reports
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'eod:read:all'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'eod:read:all'));

-- 9. Leaves & Requests Policies
DROP POLICY IF EXISTS "leaves_all" ON public.leaves;
CREATE POLICY "leaves_all" ON public.leaves
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'requests:read:all'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'requests:read:all'));

DROP POLICY IF EXISTS "requests_all" ON public.requests;
CREATE POLICY "requests_all" ON public.requests
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'requests:read:all'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'requests:read:all'));

-- 10. Announcements & Audit Logs
DROP POLICY IF EXISTS "announcements_all" ON public.announcements;
CREATE POLICY "announcements_all" ON public.announcements
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (public.has_permission(auth.uid(), 'announcements:manage:all'));

DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
CREATE POLICY "audit_logs_all" ON public.audit_logs
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'audit:read:all'))
  WITH CHECK (true);
