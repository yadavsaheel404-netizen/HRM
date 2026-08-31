REVOKE EXECUTE ON FUNCTION public.is_project_lead(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_allocated_to_project(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_view_project(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.allocation_pct_used(uuid, date, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_log_work(uuid, uuid, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.guard_allocation_acknowledgment() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_project_lead(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_allocated_to_project(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_project(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocation_pct_used(uuid, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_log_work(uuid, uuid, date) TO authenticated;