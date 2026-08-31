
-- 1. request_approvals: decisions must be attributed to the caller
DROP POLICY IF EXISTS request_approvals_update_lead ON public.request_approvals;
DROP POLICY IF EXISTS request_approvals_update_hr ON public.request_approvals;

CREATE POLICY request_approvals_update_lead ON public.request_approvals
FOR UPDATE TO authenticated
USING (tier = 'lead'::approval_tier AND approver_id = auth.uid() AND public.has_permission(auth.uid(), 'requests:approve:lead'))
WITH CHECK (
  tier = 'lead'::approval_tier
  AND approver_id = auth.uid()
  AND (
    (decision = 'pending'::approval_decision AND decided_by IS NULL AND decided_at IS NULL)
    OR (decision <> 'pending'::approval_decision AND decided_by = auth.uid() AND decided_at IS NOT NULL)
  )
);

CREATE POLICY request_approvals_update_hr ON public.request_approvals
FOR UPDATE TO authenticated
USING (tier = 'hr'::approval_tier AND public.has_permission(auth.uid(), 'requests:approve:hr'))
WITH CHECK (
  tier = 'hr'::approval_tier
  AND (
    (decision = 'pending'::approval_decision AND decided_by IS NULL AND decided_at IS NULL)
    OR (decision <> 'pending'::approval_decision AND decided_by = auth.uid() AND decided_at IS NOT NULL
        AND (approver_id IS NULL OR approver_id = auth.uid()))
  )
);

-- 2. requests: approvers may only move the decision fields
CREATE OR REPLACE FUNCTION public.guard_request_approver_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NEW.user_id = auth.uid() THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.request_type IS DISTINCT FROM OLD.request_type
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.day_id IS DISTINCT FROM OLD.day_id
     OR NEW.requested_check_in IS DISTINCT FROM OLD.requested_check_in
     OR NEW.requested_check_out IS DISTINCT FROM OLD.requested_check_out
     OR NEW.routing_reason IS DISTINCT FROM OLD.routing_reason
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Approvers may only record a decision on a request.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_request_approver_update ON public.requests;
CREATE TRIGGER guard_request_approver_update
BEFORE UPDATE ON public.requests
FOR EACH ROW EXECUTE FUNCTION public.guard_request_approver_update();

DROP POLICY IF EXISTS requests_update_approver ON public.requests;
CREATE POLICY requests_update_approver ON public.requests
FOR UPDATE TO authenticated
USING (public.has_permission(auth.uid(), 'requests:approve:hr') OR public.has_permission(auth.uid(), 'requests:approve:lead'))
WITH CHECK (public.has_permission(auth.uid(), 'requests:approve:hr') OR public.has_permission(auth.uid(), 'requests:approve:lead'));

-- 3. Scope role/permission probes to the caller unless they manage roles/workforce
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
  IF caller IS NOT NULL AND caller <> _user_id AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = caller
      AND rp.permission_key IN ('rbac:assign:all', 'workforce:read:all')
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
END;
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
  IF caller IS NOT NULL AND caller <> _user_id AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = caller
      AND rp.permission_key IN ('rbac:assign:all', 'workforce:read:all')
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = _user_id
      AND rp.permission_key = _permission
  );
END;
$$;

-- 4. Internal helper not needed by signed-in callers
REVOKE EXECUTE ON FUNCTION public.is_allocated_to_project(uuid, uuid) FROM authenticated;
