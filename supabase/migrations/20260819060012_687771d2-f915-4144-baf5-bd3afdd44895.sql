-- Helper functions must not be reachable by anonymous callers.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_reporting_lead_of(uuid, uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM anon, authenticated, PUBLIC;
-- Signed-in users still need EXECUTE: these are evaluated inside RLS policies
-- as the querying role, so revoking here would lock every table.
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_reporting_lead_of(uuid, uuid) TO authenticated;

-- job_leases is server-only; make the denial explicit rather than implicit.
CREATE POLICY job_leases_no_client_access ON public.job_leases FOR ALL TO authenticated
  USING (false) WITH CHECK (false);