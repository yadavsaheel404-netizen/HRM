INSERT INTO public.permissions (key, resource, action, scope, description)
VALUES ('attendance:update:all', 'attendance', 'update', 'all', 'Edit attendance records for all employees')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT r::app_role, 'attendance:update:all'
FROM unnest(ARRAY['super_admin','hr','admin']) AS r
ON CONFLICT DO NOTHING;

DROP POLICY IF EXISTS attendance_update_admin ON public.attendance_days;
CREATE POLICY attendance_update_admin ON public.attendance_days
FOR UPDATE TO authenticated
USING (public.has_permission(auth.uid(), 'attendance:update:all'))
WITH CHECK (public.has_permission(auth.uid(), 'attendance:update:all'));

DROP POLICY IF EXISTS eod_update_reviewer ON public.eod_reports;
CREATE POLICY eod_update_reviewer ON public.eod_reports
FOR UPDATE TO authenticated
USING (public.has_permission(auth.uid(), 'eod:review:team') AND public.is_work_lead_of(user_id, auth.uid()))
WITH CHECK (public.has_permission(auth.uid(), 'eod:review:team') AND public.is_work_lead_of(user_id, auth.uid()));

REVOKE EXECUTE ON FUNCTION public.can_view_project(uuid, uuid) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.is_project_lead(uuid, uuid) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.is_reporting_lead_of(uuid, uuid) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.is_work_lead_of(uuid, uuid) FROM authenticated, anon, public;