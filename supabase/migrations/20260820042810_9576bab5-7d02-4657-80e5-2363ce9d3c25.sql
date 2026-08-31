REVOKE ALL ON FUNCTION public.guard_profile_self_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_attendance_self_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_announcement_author() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_profile_self_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_attendance_self_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_announcement_author() TO service_role;