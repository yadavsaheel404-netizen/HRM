REVOKE EXECUTE ON FUNCTION public.attendance_day_metrics(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.derive_attendance_status(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_work_lead_of(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.guard_task_entry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_day_metrics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.derive_attendance_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_work_lead_of(uuid, uuid) TO authenticated;