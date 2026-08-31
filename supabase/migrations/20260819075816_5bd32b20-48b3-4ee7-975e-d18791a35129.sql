DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.attendance_day_metrics(uuid) TO sandbox_exec';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.derive_attendance_status(uuid) TO sandbox_exec';
  END IF;
END $$;