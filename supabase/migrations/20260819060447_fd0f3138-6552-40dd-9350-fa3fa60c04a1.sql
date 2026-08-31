GRANT EXECUTE ON FUNCTION public.claim_invitations(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_job_lease(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_job_lease(text) TO service_role;