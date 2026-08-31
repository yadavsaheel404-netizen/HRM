-- ============ enums ============
CREATE TYPE public.project_status AS ENUM ('draft','active','on_hold','completed','archived');
CREATE TYPE public.work_mode AS ENUM ('onsite','remote','hybrid');
CREATE TYPE public.allocation_status AS ENUM ('pending_acknowledgment','active','paused','ended');

-- ============ projects ============
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  client_name text,
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  project_lead_id uuid REFERENCES public.profiles(id),
  work_mode public.work_mode NOT NULL DEFAULT 'remote',
  shift text,
  task_unit text NOT NULL DEFAULT 'task',
  hourly_task_target numeric CHECK (hourly_task_target IS NULL OR hourly_task_target >= 0),
  daily_task_target numeric CHECK (daily_task_target IS NULL OR daily_task_target >= 0),
  quality_target_pct numeric CHECK (quality_target_pct IS NULL OR (quality_target_pct >= 0 AND quality_target_pct <= 100)),
  max_rejection_rate_pct numeric CHECK (max_rejection_rate_pct IS NULL OR (max_rejection_rate_pct >= 0 AND max_rejection_rate_pct <= 100)),
  required_headcount integer NOT NULL DEFAULT 0 CHECK (required_headcount >= 0),
  status public.project_status NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT ALL ON public.projects TO service_role;

CREATE TABLE public.project_team_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, lead_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_team_leads TO authenticated;
GRANT ALL ON public.project_team_leads TO service_role;

CREATE TABLE public.project_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reporting_lead_id uuid REFERENCES public.profiles(id),
  role_in_project text,
  start_date date NOT NULL DEFAULT current_date,
  end_date date,
  hours_per_day numeric NOT NULL DEFAULT 8 CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  allocation_pct numeric NOT NULL DEFAULT 100 CHECK (allocation_pct > 0 AND allocation_pct <= 100),
  daily_task_target numeric CHECK (daily_task_target IS NULL OR daily_task_target >= 0),
  quality_target_pct numeric CHECK (quality_target_pct IS NULL OR (quality_target_pct >= 0 AND quality_target_pct <= 100)),
  max_rejection_rate_pct numeric CHECK (max_rejection_rate_pct IS NULL OR (max_rejection_rate_pct >= 0 AND max_rejection_rate_pct <= 100)),
  status public.allocation_status NOT NULL DEFAULT 'pending_acknowledgment',
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES public.profiles(id),
  acknowledgment_note text,
  over_allocation_override boolean NOT NULL DEFAULT false,
  allocated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX project_allocations_one_live_per_project
  ON public.project_allocations (project_id, user_id)
  WHERE status <> 'ended';

CREATE INDEX project_allocations_user_idx ON public.project_allocations (user_id);
CREATE INDEX project_allocations_project_idx ON public.project_allocations (project_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_allocations TO authenticated;
GRANT ALL ON public.project_allocations TO service_role;

CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_project_allocations_updated BEFORE UPDATE ON public.project_allocations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ helper functions ============
CREATE OR REPLACE FUNCTION public.is_project_lead(_project_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = _project_id AND p.project_lead_id = _user_id)
      OR EXISTS (SELECT 1 FROM public.project_team_leads t WHERE t.project_id = _project_id AND t.lead_id = _user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_allocated_to_project(_project_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_allocations a
    WHERE a.project_id = _project_id AND a.user_id = _user_id AND a.status <> 'ended'
  );
$$;

CREATE OR REPLACE FUNCTION public.can_view_project(_project_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(_user_id, 'projects:read:all')
      OR public.is_project_lead(_project_id, _user_id)
      OR public.is_allocated_to_project(_project_id, _user_id);
$$;

CREATE OR REPLACE FUNCTION public.allocation_pct_used(_user_id uuid, _on_date date DEFAULT current_date, _exclude_allocation uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(a.allocation_pct), 0)
  FROM public.project_allocations a
  WHERE a.user_id = _user_id
    AND a.status <> 'ended'
    AND (_exclude_allocation IS NULL OR a.id <> _exclude_allocation)
    AND a.start_date <= _on_date
    AND (a.end_date IS NULL OR a.end_date >= _on_date);
$$;

CREATE OR REPLACE FUNCTION public.can_log_work(_user_id uuid, _project_id uuid, _on_date date DEFAULT current_date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_allocations a
    WHERE a.user_id = _user_id
      AND a.project_id = _project_id
      AND a.status = 'active'
      AND a.acknowledged_at IS NOT NULL
      AND a.start_date <= _on_date
      AND (a.end_date IS NULL OR a.end_date >= _on_date)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_project_lead(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_allocated_to_project(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.can_view_project(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.allocation_pct_used(uuid, date, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.can_log_work(uuid, uuid, date) FROM anon;

-- ============ acknowledgment forgery guard ============
CREATE OR REPLACE FUNCTION public.guard_allocation_acknowledgment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller uuid := auth.uid();
  manager boolean := false;
BEGIN
  IF caller IS NULL THEN
    RETURN NEW;
  END IF;

  manager := public.has_permission(caller, 'allocations:manage:all');

  IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
    IF OLD.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'An acknowledgment cannot be changed once recorded.';
    END IF;
    IF caller <> NEW.user_id OR NEW.acknowledged_by IS DISTINCT FROM caller THEN
      RAISE EXCEPTION 'Only the assigned person can acknowledge this allocation.';
    END IF;
  END IF;

  IF NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by
     AND NEW.acknowledged_by IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'Only the assigned person can acknowledge this allocation.';
  END IF;

  IF NOT manager THEN
    IF caller <> OLD.user_id THEN
      RAISE EXCEPTION 'You cannot modify this allocation.';
    END IF;
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.reporting_lead_id IS DISTINCT FROM OLD.reporting_lead_id
       OR NEW.role_in_project IS DISTINCT FROM OLD.role_in_project
       OR NEW.start_date IS DISTINCT FROM OLD.start_date
       OR NEW.end_date IS DISTINCT FROM OLD.end_date
       OR NEW.hours_per_day IS DISTINCT FROM OLD.hours_per_day
       OR NEW.allocation_pct IS DISTINCT FROM OLD.allocation_pct
       OR NEW.daily_task_target IS DISTINCT FROM OLD.daily_task_target
       OR NEW.quality_target_pct IS DISTINCT FROM OLD.quality_target_pct
       OR NEW.max_rejection_rate_pct IS DISTINCT FROM OLD.max_rejection_rate_pct
       OR NEW.allocated_by IS DISTINCT FROM OLD.allocated_by
       OR NEW.over_allocation_override IS DISTINCT FROM OLD.over_allocation_override THEN
      RAISE EXCEPTION 'You can only acknowledge this allocation, not change its terms.';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'pending_acknowledgment' AND NEW.status = 'active') THEN
      RAISE EXCEPTION 'You cannot change the status of this allocation.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocation_ack_guard
  BEFORE UPDATE ON public.project_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_allocation_acknowledgment();

-- ============ RLS: projects ============
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_select ON public.projects FOR SELECT TO authenticated
  USING (public.can_view_project(id, auth.uid()));
CREATE POLICY projects_insert ON public.projects FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'projects:manage:all'));
CREATE POLICY projects_update ON public.projects FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'projects:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'projects:manage:all'));
CREATE POLICY projects_delete ON public.projects FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'projects:manage:all'));

-- ============ RLS: project_team_leads ============
ALTER TABLE public.project_team_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY ptl_select ON public.project_team_leads FOR SELECT TO authenticated
  USING (public.can_view_project(project_id, auth.uid()));
CREATE POLICY ptl_insert ON public.project_team_leads FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'projects:manage:all'));
CREATE POLICY ptl_update ON public.project_team_leads FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'projects:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'projects:manage:all'));
CREATE POLICY ptl_delete ON public.project_team_leads FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'projects:manage:all'));

-- ============ RLS: project_allocations ============
ALTER TABLE public.project_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY allocations_select_self ON public.project_allocations FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY allocations_select_all ON public.project_allocations FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'allocations:read:all'));
CREATE POLICY allocations_select_team ON public.project_allocations FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'allocations:read:team')
    AND (reporting_lead_id = auth.uid() OR public.is_project_lead(project_id, auth.uid()))
  );
CREATE POLICY allocations_insert_manage ON public.project_allocations FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'allocations:manage:all'));
CREATE POLICY allocations_update_manage ON public.project_allocations FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'allocations:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'allocations:manage:all'));
CREATE POLICY allocations_update_self_ack ON public.project_allocations FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
CREATE POLICY allocations_delete_manage ON public.project_allocations FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'allocations:manage:all'));

-- ============ permissions catalogue ============
INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('projects:read:all', 'projects', 'read', 'all', 'View every project in the organisation'),
  ('projects:read:team', 'projects', 'read', 'team', 'View projects they lead'),
  ('projects:manage:all', 'projects', 'manage', 'all', 'Create and edit projects'),
  ('allocations:read:all', 'allocations', 'read', 'all', 'View every project allocation'),
  ('allocations:read:team', 'allocations', 'read', 'team', 'View allocations of their team'),
  ('allocations:manage:all', 'allocations', 'manage', 'all', 'Allocate people to projects'),
  ('allocations:acknowledge:self', 'allocations', 'acknowledge', 'self', 'Acknowledge their own project assignment')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key) VALUES
  ('super_admin','projects:read:all'),('super_admin','projects:read:team'),('super_admin','projects:manage:all'),
  ('super_admin','allocations:read:all'),('super_admin','allocations:read:team'),('super_admin','allocations:manage:all'),
  ('super_admin','allocations:acknowledge:self'),
  ('admin','projects:read:all'),('admin','projects:read:team'),('admin','projects:manage:all'),
  ('admin','allocations:read:all'),('admin','allocations:read:team'),('admin','allocations:manage:all'),
  ('admin','allocations:acknowledge:self'),
  ('hr','projects:read:all'),('hr','allocations:read:all'),('hr','allocations:read:team'),
  ('hr','allocations:manage:all'),('hr','allocations:acknowledge:self'),
  ('founder','projects:read:all'),('founder','allocations:read:all'),('founder','allocations:acknowledge:self'),
  ('lead','projects:read:team'),('lead','allocations:read:team'),('lead','allocations:acknowledge:self'),
  ('employee','allocations:acknowledge:self')
ON CONFLICT DO NOTHING;