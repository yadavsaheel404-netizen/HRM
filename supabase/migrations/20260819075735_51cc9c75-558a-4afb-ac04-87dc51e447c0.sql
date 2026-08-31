GRANT EXECUTE ON FUNCTION public.attendance_day_metrics(uuid) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.derive_attendance_status(uuid) TO service_role, postgres;