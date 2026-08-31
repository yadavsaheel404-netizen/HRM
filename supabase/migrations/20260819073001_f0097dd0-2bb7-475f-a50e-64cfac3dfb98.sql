-- ===== Phase 3: Daily Cycle =====
CREATE TYPE public.attendance_work_mode AS ENUM ('wfo','wfh','hybrid','client_location','field_work');
CREATE TYPE public.day_exception AS ENUM ('none','leave','holiday','weekly_off');
CREATE TYPE public.attendance_status AS ENUM (
  'present_complete','present_hours_incomplete','present_eod_pending','half_day',
  'missed_check_out','absent','on_leave','holiday','weekly_off','review_required');
CREATE TYPE public.task_entry_status AS ENUM ('draft','submitted','reviewed','revision_required','approved');
CREATE TYPE public.task_slot_type AS ENUM ('fixed','flexible');
CREATE TYPE public.break_category AS ENUM ('lunch','short_break','personal','meeting','training','other');
CREATE TYPE public.blocker_category AS ENUM ('data_quality','tooling','access','dependency','guidance','client','personal','other');
CREATE TYPE public.blocker_status AS ENUM ('open','acknowledged','resolved');
CREATE TYPE public.eod_status AS ENUM ('draft','submitted','reviewed','approved');

CREATE TABLE public.attendance_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  work_date date NOT NULL DEFAULT CURRENT_DATE,
  work_mode public.attendance_work_mode NOT NULL DEFAULT 'wfh',
  check_in_at timestamptz,
  check_out_at timestamptz,
  late_reason text,
  check_in_device jsonb NOT NULL DEFAULT '{}'::jsonb,
  check_out_device jsonb NOT NULL DEFAULT '{}'::jsonb,
  exception_type public.day_exception NOT NULL DEFAULT 'none',
  exception_note text,
  required_minutes integer NOT NULL DEFAULT 480,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date),
  CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at > check_in_at)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_days TO authenticated;
GRANT ALL ON public.attendance_days TO service_role;
ALTER TABLE public.attendance_days ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.task_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  allocation_id uuid REFERENCES public.project_allocations(id) ON DELETE SET NULL,
  slot_type public.task_slot_type NOT NULL DEFAULT 'flexible',
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  task_description text NOT NULL,
  units_completed numeric NOT NULL DEFAULT 0,
  units_approved numeric,
  units_rejected numeric,
  status public.task_entry_status NOT NULL DEFAULT 'draft',
  reviewer_id uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at > started_at),
  CHECK (units_completed >= 0)
);
CREATE INDEX task_entries_day_idx ON public.task_entries (day_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_entries TO authenticated;
GRANT ALL ON public.task_entries TO service_role;
ALTER TABLE public.task_entries ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.break_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category public.break_category NOT NULL DEFAULT 'short_break',
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.break_logs TO authenticated;
GRANT ALL ON public.break_logs TO service_role;
ALTER TABLE public.break_logs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.blockers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  allocation_id uuid REFERENCES public.project_allocations(id) ON DELETE SET NULL,
  category public.blocker_category NOT NULL DEFAULT 'other',
  severity text NOT NULL DEFAULT 'medium',
  description text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  status public.blocker_status NOT NULL DEFAULT 'open',
  notified_lead_id uuid REFERENCES public.profiles(id),
  notified_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blockers TO authenticated;
GRANT ALL ON public.blockers TO service_role;
ALTER TABLE public.blockers ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles(id),
  type text NOT NULL,
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON public.notifications (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.eod_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL UNIQUE REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  highlights text,
  challenges text,
  tomorrow_plan text,
  support_needed text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.eod_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eod_reports TO authenticated;
GRANT ALL ON public.eod_reports TO service_role;
ALTER TABLE public.eod_reports ENABLE ROW LEVEL SECURITY;

INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('attendance:log:self','attendance','log','self','Check in and out for yourself'),
  ('attendance:read:self','attendance','read','self','Read your own attendance'),
  ('attendance:read:team','attendance','read','team','Read attendance for your team'),
  ('attendance:read:all','attendance','read','all','Read attendance across the org'),
  ('tasks:log:self','tasks','log','self','Log your own hourly task entries'),
  ('tasks:read:team','tasks','read','team','Read task entries for your team'),
  ('tasks:read:all','tasks','read','all','Read task entries across the org'),
  ('tasks:review:team','tasks','review','team','Review, approve or return task entries'),
  ('blockers:raise:self','blockers','raise','self','Raise blockers on your own work'),
  ('blockers:manage:team','blockers','manage','team','Acknowledge and resolve team blockers'),
  ('eod:submit:self','eod','submit','self','Submit your own EOD report'),
  ('eod:read:team','eod','read','team','Read EOD reports for your team'),
  ('eod:read:all','eod','read','all','Read EOD reports across the org');

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES ('employee'::public.app_role)) r(role),
  (VALUES ('attendance:log:self'),('attendance:read:self'),('tasks:log:self'),('blockers:raise:self'),('eod:submit:self')) p(key);

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES ('lead'::public.app_role)) r(role),
  (VALUES ('attendance:log:self'),('attendance:read:self'),('attendance:read:team'),('tasks:log:self'),
          ('tasks:read:team'),('tasks:review:team'),('blockers:raise:self'),('blockers:manage:team'),
          ('eod:submit:self'),('eod:read:team')) p(key);

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES ('hr'::public.app_role),('admin'::public.app_role),
                                  ('founder'::public.app_role),('super_admin'::public.app_role)) r(role),
  (VALUES ('attendance:log:self'),('attendance:read:self'),('attendance:read:team'),('attendance:read:all'),
          ('tasks:log:self'),('tasks:read:team'),('tasks:read:all'),('tasks:review:team'),
          ('blockers:raise:self'),('blockers:manage:team'),
          ('eod:submit:self'),('eod:read:team'),('eod:read:all')) p(key);

CREATE OR REPLACE FUNCTION public.is_work_lead_of(_owner uuid, _viewer uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_reporting_lead_of(_viewer, _owner)
      OR EXISTS (SELECT 1 FROM public.project_allocations a
                 WHERE a.user_id = _owner AND a.status <> 'ended'
                   AND (a.reporting_lead_id = _viewer OR public.is_project_lead(a.project_id, _viewer)));
$$;

CREATE OR REPLACE FUNCTION public.attendance_day_metrics(_day_id uuid)
RETURNS TABLE (
  worked_minutes integer, task_minutes integer, break_minutes integer, blocker_minutes integer,
  covered_minutes integer, uncovered_minutes integer, units_completed numeric,
  entry_count integer, unsubmitted_entries integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d public.attendance_days; s timestamptz; e timestamptz;
BEGIN
  SELECT * INTO d FROM public.attendance_days WHERE id = _day_id;
  IF NOT FOUND OR d.check_in_at IS NULL THEN
    RETURN QUERY SELECT 0,0,0,0,0,0,0::numeric,0,0; RETURN;
  END IF;
  s := d.check_in_at;
  e := COALESCE(d.check_out_at, GREATEST(d.check_in_at, now()));

  RETURN QUERY
  WITH iv AS (
    SELECT 'task'::text kind, GREATEST(t.started_at, s) st, LEAST(t.ended_at, e) en
      FROM public.task_entries t WHERE t.day_id = _day_id
    UNION ALL
    SELECT 'break', GREATEST(b.started_at, s), LEAST(COALESCE(b.ended_at, e), e)
      FROM public.break_logs b WHERE b.day_id = _day_id
    UNION ALL
    SELECT 'blocker', GREATEST(k.started_at, s), LEAST(COALESCE(k.resolved_at, e), e)
      FROM public.blockers k WHERE k.day_id = _day_id
  ), c AS (SELECT kind, st, en FROM iv WHERE en > st),
  ordered AS (
    SELECT st, en, MAX(en) OVER (ORDER BY st ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prev_max
      FROM c
  ), grp AS (
    SELECT st, en, SUM(CASE WHEN prev_max IS NULL OR st > prev_max THEN 1 ELSE 0 END)
                     OVER (ORDER BY st ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) g
      FROM ordered
  ), merged AS (
    SELECT MIN(st) st, MAX(en) en FROM grp GROUP BY g
  )
  SELECT
    (EXTRACT(EPOCH FROM (e - s)) / 60)::int,
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (en - st)) / 60) FROM c WHERE kind = 'task'), 0)::int,
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (en - st)) / 60) FROM c WHERE kind = 'break'), 0)::int,
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (en - st)) / 60) FROM c WHERE kind = 'blocker'), 0)::int,
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (en - st)) / 60) FROM merged), 0)::int,
    GREATEST((EXTRACT(EPOCH FROM (e - s)) / 60)::int
             - COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (en - st)) / 60) FROM merged), 0)::int, 0),
    COALESCE((SELECT SUM(t.units_completed) FROM public.task_entries t WHERE t.day_id = _day_id), 0),
    (SELECT COUNT(*) FROM public.task_entries t WHERE t.day_id = _day_id)::int,
    (SELECT COUNT(*) FROM public.task_entries t WHERE t.day_id = _day_id AND t.status = 'draft')::int;
END;
$$;

CREATE OR REPLACE FUNCTION public.derive_attendance_status(_day_id uuid)
RETURNS public.attendance_status LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.attendance_days; m record; eod public.eod_reports; required int; worked int;
BEGIN
  SELECT * INTO d FROM public.attendance_days WHERE id = _day_id;
  IF NOT FOUND THEN RETURN 'absent'; END IF;

  IF d.exception_type = 'holiday'     THEN RETURN 'holiday';     END IF;
  IF d.exception_type = 'weekly_off'  THEN RETURN 'weekly_off';  END IF;
  IF d.exception_type = 'leave'       THEN RETURN 'on_leave';    END IF;

  SELECT * INTO eod FROM public.eod_reports WHERE day_id = _day_id;

  IF d.check_in_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.task_entries t WHERE t.day_id = _day_id) OR eod.id IS NOT NULL
      THEN RETURN 'review_required'; END IF;
    RETURN 'absent';
  END IF;

  IF d.check_out_at IS NULL THEN
    IF d.work_date < CURRENT_DATE THEN RETURN 'missed_check_out'; END IF;
    RETURN 'present_eod_pending';
  END IF;

  SELECT * INTO m FROM public.attendance_day_metrics(_day_id);
  required := GREATEST(d.required_minutes, 1);
  worked := m.worked_minutes;

  IF worked < (required * 0.5) THEN RETURN 'half_day'; END IF;
  IF worked > 0 AND m.uncovered_minutes > (worked * 0.25) THEN RETURN 'review_required'; END IF;
  IF m.unsubmitted_entries > 0 THEN RETURN 'review_required'; END IF;
  IF eod.id IS NULL OR eod.status = 'draft' THEN RETURN 'present_eod_pending'; END IF;
  IF worked + 15 < required THEN RETURN 'present_hours_incomplete'; END IF;

  RETURN 'present_complete';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.attendance_day_metrics(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.derive_attendance_status(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_work_lead_of(uuid, uuid) FROM anon;

CREATE OR REPLACE FUNCTION public.guard_task_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE caller uuid := auth.uid(); reviewer boolean := false; overlap_count int;
BEGIN
  IF caller IS NULL THEN RETURN NEW; END IF;
  reviewer := public.has_permission(caller, 'tasks:review:team');

  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NOT reviewer THEN
    RAISE EXCEPTION 'This entry is approved and locked.';
  END IF;

  IF NOT reviewer AND NEW.status IN ('reviewed','approved','revision_required')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Only a reviewer can move an entry to %.', NEW.status;
  END IF;

  IF NEW.ended_at <= NEW.started_at THEN
    RAISE EXCEPTION 'The entry must end after it starts.';
  END IF;

  SELECT COUNT(*) INTO overlap_count FROM public.task_entries t
   WHERE t.user_id = NEW.user_id AND t.id <> NEW.id
     AND tstzrange(t.started_at, t.ended_at) && tstzrange(NEW.started_at, NEW.ended_at);
  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'That time range overlaps an existing task entry.';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_task_entry_guard BEFORE INSERT OR UPDATE ON public.task_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_entry();
CREATE TRIGGER trg_task_entries_updated BEFORE UPDATE ON public.task_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_attendance_days_updated BEFORE UPDATE ON public.attendance_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_eod_reports_updated BEFORE UPDATE ON public.eod_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE POLICY attendance_select_self ON public.attendance_days FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY attendance_select_team ON public.attendance_days FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'attendance:read:team') AND public.is_work_lead_of(user_id, auth.uid()));
CREATE POLICY attendance_select_all ON public.attendance_days FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'attendance:read:all'));
CREATE POLICY attendance_insert_self ON public.attendance_days FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_permission(auth.uid(), 'attendance:log:self'));
CREATE POLICY attendance_update_self ON public.attendance_days FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY attendance_update_admin ON public.attendance_days FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'attendance:read:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'attendance:read:all'));
CREATE POLICY attendance_delete_admin ON public.attendance_days FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'org:manage:all'));

CREATE POLICY tasks_select_self ON public.task_entries FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY tasks_select_team ON public.task_entries FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'tasks:read:team') AND public.is_work_lead_of(user_id, auth.uid()));
CREATE POLICY tasks_select_all ON public.task_entries FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'tasks:read:all'));
CREATE POLICY tasks_insert_self ON public.task_entries FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_permission(auth.uid(), 'tasks:log:self')
              AND public.can_log_work(auth.uid(), project_id));
CREATE POLICY tasks_update_self ON public.task_entries FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status <> 'approved') WITH CHECK (user_id = auth.uid());
CREATE POLICY tasks_update_reviewer ON public.task_entries FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'tasks:review:team')
         AND (public.is_work_lead_of(user_id, auth.uid()) OR public.has_permission(auth.uid(), 'tasks:read:all')))
  WITH CHECK (public.has_permission(auth.uid(), 'tasks:review:team'));
CREATE POLICY tasks_delete_self ON public.task_entries FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND status IN ('draft','revision_required'));

CREATE POLICY breaks_select_self ON public.break_logs FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY breaks_select_team ON public.break_logs FOR SELECT TO authenticated
  USING ((public.has_permission(auth.uid(), 'attendance:read:team') AND public.is_work_lead_of(user_id, auth.uid()))
         OR public.has_permission(auth.uid(), 'attendance:read:all'));
CREATE POLICY breaks_insert_self ON public.break_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_permission(auth.uid(), 'attendance:log:self'));
CREATE POLICY breaks_update_self ON public.break_logs FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY breaks_delete_self ON public.break_logs FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY blockers_select_self ON public.blockers FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR notified_lead_id = auth.uid());
CREATE POLICY blockers_select_team ON public.blockers FOR SELECT TO authenticated
  USING ((public.has_permission(auth.uid(), 'blockers:manage:team') AND public.is_work_lead_of(user_id, auth.uid()))
         OR public.has_permission(auth.uid(), 'tasks:read:all'));
CREATE POLICY blockers_insert_self ON public.blockers FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_permission(auth.uid(), 'blockers:raise:self'));
CREATE POLICY blockers_update_self ON public.blockers FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY blockers_update_lead ON public.blockers FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'blockers:manage:team')
         AND (notified_lead_id = auth.uid() OR public.is_work_lead_of(user_id, auth.uid())))
  WITH CHECK (public.has_permission(auth.uid(), 'blockers:manage:team'));
CREATE POLICY blockers_delete_self ON public.blockers FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND status = 'open');

CREATE POLICY notifications_select_own ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY notifications_insert_authenticated ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());
CREATE POLICY notifications_update_own ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY notifications_delete_own ON public.notifications FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY eod_select_self ON public.eod_reports FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY eod_select_team ON public.eod_reports FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'eod:read:team') AND public.is_work_lead_of(user_id, auth.uid()));
CREATE POLICY eod_select_all ON public.eod_reports FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'eod:read:all'));
CREATE POLICY eod_insert_self ON public.eod_reports FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_permission(auth.uid(), 'eod:submit:self'));
CREATE POLICY eod_update_self ON public.eod_reports FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status IN ('draft','submitted')) WITH CHECK (user_id = auth.uid());
CREATE POLICY eod_update_reviewer ON public.eod_reports FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'eod:read:team') AND public.is_work_lead_of(user_id, auth.uid()))
  WITH CHECK (public.has_permission(auth.uid(), 'eod:read:team'));
CREATE POLICY eod_delete_self ON public.eod_reports FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND status = 'draft');