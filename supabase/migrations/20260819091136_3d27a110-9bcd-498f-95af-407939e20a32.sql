CREATE OR REPLACE FUNCTION public.day_targets(_day_id uuid)
RETURNS TABLE(project_code text, hourly_task_target numeric, daily_task_target numeric, quality_target_pct numeric, max_rejection_rate_pct numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE owner uuid;
BEGIN
  SELECT d.user_id INTO owner FROM public.attendance_days d WHERE d.id = _day_id;
  IF owner IS NULL THEN RETURN; END IF;

  IF NOT (owner = auth.uid()
          OR public.has_permission(auth.uid(), 'attendance:read:all')
          OR (public.has_permission(auth.uid(), 'attendance:read:team') AND public.is_work_lead_of(owner, auth.uid()))) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.code,
         COALESCE(a.daily_task_target / NULLIF(a.hours_per_day, 0), p.hourly_task_target),
         COALESCE(a.daily_task_target, p.daily_task_target),
         COALESCE(a.quality_target_pct, p.quality_target_pct),
         COALESCE(a.max_rejection_rate_pct, p.max_rejection_rate_pct)
  FROM public.task_entries t
  JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.project_allocations a ON a.id = t.allocation_id
  WHERE t.day_id = _day_id
  GROUP BY p.code, p.hourly_task_target, p.daily_task_target, p.quality_target_pct, p.max_rejection_rate_pct,
           a.daily_task_target, a.hours_per_day, a.quality_target_pct, a.max_rejection_rate_pct
  ORDER BY COUNT(*) DESC
  LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.day_targets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.day_targets(uuid) TO authenticated;