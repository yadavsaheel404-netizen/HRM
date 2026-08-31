-- 1. Documents: self-updates can never mark a document verified or forge review fields
DROP POLICY IF EXISTS documents_update_self ON public.documents;
CREATE POLICY documents_update_self ON public.documents
FOR UPDATE TO authenticated
USING (user_id = auth.uid() AND status <> 'verified'::document_status)
WITH CHECK (
  user_id = auth.uid()
  AND status = 'pending'::document_status
  AND reviewed_by IS NULL
  AND reviewed_at IS NULL
  AND review_note IS NULL
);

-- 2. Request approvals: the requester may only create pending, undecided rows
DROP POLICY IF EXISTS request_approvals_insert ON public.request_approvals;
CREATE POLICY request_approvals_insert ON public.request_approvals
FOR INSERT TO authenticated
WITH CHECK (
  (
    EXISTS (SELECT 1 FROM public.requests r WHERE r.id = request_id AND r.user_id = auth.uid())
    AND decision = 'pending'::approval_decision
    AND decided_by IS NULL
    AND decided_at IS NULL
  )
  OR has_permission(auth.uid(), 'requests:approve:hr'::text)
);

-- 3. Profiles: block self-service edits of status / verification / org-structure fields
CREATE OR REPLACE FUNCTION public.guard_profile_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
  IF caller IS NULL OR public.has_permission(caller, 'workforce:update:all') THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'You cannot change this profile.';
  END IF;

  IF NEW.work_email IS DISTINCT FROM OLD.work_email
     OR NEW.employment_status IS DISTINCT FROM OLD.employment_status
     OR NEW.profile_verified_at IS DISTINCT FROM OLD.profile_verified_at
     OR NEW.profile_verified_by IS DISTINCT FROM OLD.profile_verified_by
     OR NEW.needs_assignment IS DISTINCT FROM OLD.needs_assignment
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.reporting_lead_id IS DISTINCT FROM OLD.reporting_lead_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.designation IS DISTINCT FROM OLD.designation
     OR NEW.employee_code IS DISTINCT FROM OLD.employee_code
     OR NEW.joining_date IS DISTINCT FROM OLD.joining_date
     OR NEW.last_working_day IS DISTINCT FROM OLD.last_working_day
     OR NEW.work_location IS DISTINCT FROM OLD.work_location THEN
    RAISE EXCEPTION 'Only HR can change employment and verification details.';
  END IF;

  IF NEW.account_status IS DISTINCT FROM OLD.account_status
     AND NOT (
       (OLD.account_status = 'activated' AND NEW.account_status = 'profile_pending')
       OR (OLD.account_status = 'profile_pending' AND NEW.account_status = 'under_verification')
     ) THEN
    RAISE EXCEPTION 'You cannot change your account status.';
  END IF;

  IF NEW.account_status = 'under_verification'
     AND OLD.account_status = 'profile_pending'
     AND NEW.profile_submitted_at IS NULL THEN
    NEW.profile_submitted_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_self_update_guard ON public.profiles;
CREATE TRIGGER trg_profile_self_update_guard
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_self_update();

-- 4. Attendance: self-updates limited to check-in / check-out fields
CREATE OR REPLACE FUNCTION public.guard_attendance_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
  IF caller IS NULL OR public.has_permission(caller, 'attendance:read:all') THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.exception_type IS DISTINCT FROM OLD.exception_type
     OR NEW.exception_note IS DISTINCT FROM OLD.exception_note
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
    RAISE EXCEPTION 'Only an administrator can change these attendance details.';
  END IF;

  -- required_minutes is derived from allocations at check-in only
  IF NEW.required_minutes IS DISTINCT FROM OLD.required_minutes AND OLD.check_in_at IS NOT NULL THEN
    RAISE EXCEPTION 'Required hours cannot be changed after check-in.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_self_update_guard ON public.attendance_days;
CREATE TRIGGER trg_attendance_self_update_guard
BEFORE UPDATE ON public.attendance_days
FOR EACH ROW EXECUTE FUNCTION public.guard_attendance_self_update();

-- 5. Announcements: author cannot be rewritten
CREATE OR REPLACE FUNCTION public.guard_announcement_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_announcement_author_guard ON public.announcements;
CREATE TRIGGER trg_announcement_author_guard
BEFORE UPDATE ON public.announcements
FOR EACH ROW EXECUTE FUNCTION public.guard_announcement_author();

DROP POLICY IF EXISTS announcements_update ON public.announcements;
CREATE POLICY announcements_update ON public.announcements
FOR UPDATE TO authenticated
USING (has_permission(auth.uid(), 'announcements:manage:all'::text))
WITH CHECK (has_permission(auth.uid(), 'announcements:manage:all'::text) AND created_by IS NOT NULL);

-- 6. SECURITY DEFINER helpers callable by signed-in users now check the caller
CREATE OR REPLACE FUNCTION public.attendance_day_metrics(_day_id uuid)
 RETURNS TABLE(worked_minutes integer, task_minutes integer, break_minutes integer, blocker_minutes integer, covered_minutes integer, uncovered_minutes integer, units_completed numeric, entry_count integer, unsubmitted_entries integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE d public.attendance_days; s timestamptz; e timestamptz; caller uuid := auth.uid();
BEGIN
  SELECT * INTO d FROM public.attendance_days WHERE id = _day_id;
  IF NOT FOUND OR d.check_in_at IS NULL THEN
    RETURN QUERY SELECT 0,0,0,0,0,0,0::numeric,0,0; RETURN;
  END IF;

  IF caller IS NOT NULL AND NOT (
       d.user_id = caller
       OR public.has_permission(caller, 'attendance:read:all')
       OR (public.has_permission(caller, 'attendance:read:team') AND public.is_work_lead_of(d.user_id, caller))
     ) THEN
    RAISE EXCEPTION 'Not authorised to view this day.';
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
$function$;

CREATE OR REPLACE FUNCTION public.derive_attendance_status(_day_id uuid)
 RETURNS attendance_status
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d public.attendance_days; m record; eod public.eod_reports; required int; worked int; caller uuid := auth.uid();
BEGIN
  SELECT * INTO d FROM public.attendance_days WHERE id = _day_id;
  IF NOT FOUND THEN RETURN 'absent'; END IF;

  IF caller IS NOT NULL AND NOT (
       d.user_id = caller
       OR public.has_permission(caller, 'attendance:read:all')
       OR (public.has_permission(caller, 'attendance:read:team') AND public.is_work_lead_of(d.user_id, caller))
     ) THEN
    RAISE EXCEPTION 'Not authorised to view this day.';
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.allocation_pct_used(_user_id uuid, _on_date date DEFAULT CURRENT_DATE, _exclude_allocation uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE caller uuid := auth.uid(); total numeric;
BEGIN
  IF caller IS NOT NULL AND NOT (
       _user_id = caller
       OR public.has_permission(caller, 'allocations:manage:all')
       OR public.has_permission(caller, 'allocations:read:all')
       OR (public.has_permission(caller, 'allocations:read:team') AND public.is_work_lead_of(_user_id, caller))
     ) THEN
    RAISE EXCEPTION 'Not authorised to view this capacity.';
  END IF;

  SELECT COALESCE(SUM(a.allocation_pct), 0) INTO total
  FROM public.project_allocations a
  WHERE a.user_id = _user_id
    AND a.status <> 'ended'
    AND (_exclude_allocation IS NULL OR a.id <> _exclude_allocation)
    AND a.start_date <= _on_date
    AND (a.end_date IS NULL OR a.end_date >= _on_date);

  RETURN total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.can_log_work(_user_id uuid, _project_id uuid, _on_date date DEFAULT CURRENT_DATE)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE caller uuid := auth.uid();
BEGIN
  IF caller IS NOT NULL AND NOT (
       _user_id = caller
       OR public.has_permission(caller, 'allocations:read:all')
       OR (public.has_permission(caller, 'allocations:read:team') AND public.is_work_lead_of(_user_id, caller))
     ) THEN
    RAISE EXCEPTION 'Not authorised.';
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.project_allocations a
    WHERE a.user_id = _user_id
      AND a.project_id = _project_id
      AND a.status = 'active'
      AND a.acknowledged_at IS NOT NULL
      AND a.start_date <= _on_date
      AND (a.end_date IS NULL OR a.end_date >= _on_date)
  );
END;
$function$;

-- Internal helpers should not be callable by signed-in users at all
REVOKE ALL ON FUNCTION public.attendance_day_metrics(uuid) FROM sandbox_exec;
REVOKE ALL ON FUNCTION public.derive_attendance_status(uuid) FROM sandbox_exec;