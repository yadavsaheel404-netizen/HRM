-- Documents: verifiers no longer create rows for arbitrary employees.
DROP POLICY IF EXISTS documents_insert_all ON public.documents;

-- Requests: lead-tier approvers must actually lead the requester.
DROP POLICY IF EXISTS requests_update_approver ON public.requests;
CREATE POLICY requests_update_approver ON public.requests
FOR UPDATE TO authenticated
USING (
  public.has_permission(auth.uid(), 'requests:approve:hr')
  OR (
    public.has_permission(auth.uid(), 'requests:approve:lead')
    AND public.is_work_lead_of(user_id, auth.uid())
  )
)
WITH CHECK (
  public.has_permission(auth.uid(), 'requests:approve:hr')
  OR (
    public.has_permission(auth.uid(), 'requests:approve:lead')
    AND public.is_work_lead_of(user_id, auth.uid())
  )
);