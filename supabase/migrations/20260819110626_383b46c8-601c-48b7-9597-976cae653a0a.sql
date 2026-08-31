CREATE OR REPLACE FUNCTION public.profile_names(_ids uuid[])
RETURNS TABLE(id uuid, full_name text, designation text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name, p.designation
  FROM public.profiles p
  WHERE p.id = ANY(COALESCE(_ids, ARRAY[]::uuid[]))
    AND auth.uid() IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.profile_names(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.profile_names(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.profile_names(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.profile_names(uuid[]) TO service_role;