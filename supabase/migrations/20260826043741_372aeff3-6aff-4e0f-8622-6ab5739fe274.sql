-- These four helpers are referenced directly inside RLS policy expressions,
-- which are evaluated with the privileges of the calling role (authenticated).
-- Revoking EXECUTE from authenticated therefore broke every policy that calls
-- them ("permission denied for function is_reporting_lead_of"), which blocked
-- reads on profiles-adjacent tables and crashed /onboarding.
GRANT EXECUTE ON FUNCTION public.is_reporting_lead_of(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_work_lead_of(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_project_lead(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_project(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_allocated_to_project(uuid, uuid) TO authenticated;