CREATE OR REPLACE FUNCTION public.profile_names(_ids uuid[])
 RETURNS TABLE(id uuid, full_name text, designation text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.id, p.full_name, p.designation
  FROM public.profiles p
  WHERE p.id = ANY(COALESCE(_ids, ARRAY[]::uuid[]))
    AND (
      auth.uid() IS NULL
      OR p.id = auth.uid()
      OR public.has_permission(auth.uid(), 'workforce:read:all')
      OR (public.has_permission(auth.uid(), 'workforce:read:team') AND p.reporting_lead_id = auth.uid())
      OR public.is_work_lead_of(p.id, auth.uid())
      OR public.is_work_lead_of(auth.uid(), p.id)
    );
$function$;