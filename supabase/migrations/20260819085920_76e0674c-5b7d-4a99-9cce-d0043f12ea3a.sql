-- ============ Enums ============
CREATE TYPE public.request_type AS ENUM ('leave','wfh','attendance_correction');
CREATE TYPE public.request_status AS ENUM ('pending','approved','rejected','cancelled');
CREATE TYPE public.approval_tier AS ENUM ('lead','hr');
CREATE TYPE public.approval_decision AS ENUM ('pending','approved','rejected');
CREATE TYPE public.review_action AS ENUM ('approved','approved_with_comment','revision_requested','escalated','performance_concern');

ALTER TYPE public.eod_status ADD VALUE IF NOT EXISTS 'revision_required';
ALTER TYPE public.eod_status ADD VALUE IF NOT EXISTS 'escalated';
ALTER TYPE public.eod_status ADD VALUE IF NOT EXISTS 'performance_concern';

-- ============ Permissions ============
INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('requests:submit:self','requests','submit','self','Submit leave / WFH / attendance-correction requests for yourself'),
  ('requests:read:self','requests','read','self','See your own requests'),
  ('requests:read:team','requests','read','team','See requests raised by your team'),
  ('requests:read:all','requests','read','all','See every request in the organisation'),
  ('requests:approve:lead','requests','approve','team','Record the reporting-lead decision on a request'),
  ('requests:approve:hr','requests','approve','all','Record the HR decision on a request'),
  ('eod:review:team','eod','review','team','Review, escalate or flag EOD reports for your team'),
  ('announcements:read:all','announcements','read','all','Read organisation announcements'),
  ('announcements:manage:all','announcements','manage','all','Publish and manage organisation announcements'),
  ('analytics:read:team','analytics','read','team','See productivity and attendance analytics for your team'),
  ('analytics:read:all','analytics','read','all','See organisation-wide productivity and attendance analytics')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES
  ('super_admin'::app_role),('founder'::app_role),('hr'::app_role),('admin'::app_role),('lead'::app_role),('employee'::app_role)
) AS r(role)
CROSS JOIN (VALUES ('requests:submit:self'),('requests:read:self'),('announcements:read:all')) AS p(key)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES ('lead'::app_role)) AS r(role)
CROSS JOIN (VALUES ('requests:read:team'),('requests:approve:lead'),('eod:review:team'),('analytics:read:team')) AS p(key)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES ('hr'::app_role),('admin'::app_role),('super_admin'::app_role)) AS r(role)
CROSS JOIN (VALUES ('requests:read:all'),('requests:approve:hr'),('eod:review:team'),('announcements:manage:all'),('analytics:read:all')) AS p(key)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role, p.key FROM (VALUES ('founder'::app_role)) AS r(role)
CROSS JOIN (VALUES ('requests:read:all'),('analytics:read:all')) AS p(key)
ON CONFLICT DO NOTHING;

-- ============ requests ============
CREATE TABLE public.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  request_type public.request_type NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  day_id uuid REFERENCES public.attendance_days(id),
  requested_check_in timestamptz,
  requested_check_out timestamptz,
  status public.request_status NOT NULL DEFAULT 'pending',
  routing_reason text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_user_idx ON public.requests(user_id, submitted_at DESC);
CREATE INDEX requests_status_idx ON public.requests(status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.requests TO authenticated;
GRANT ALL ON public.requests TO service_role;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "requests_select_self" ON public.requests FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "requests_select_team" ON public.requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(),'requests:read:team') AND public.is_work_lead_of(user_id, auth.uid()));
CREATE POLICY "requests_select_all" ON public.requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(),'requests:read:all'));
CREATE POLICY "requests_insert_self" ON public.requests FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_permission(auth.uid(),'requests:submit:self'));
CREATE POLICY "requests_update_self_pending" ON public.requests FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND status = 'pending') WITH CHECK (user_id = auth.uid());
CREATE POLICY "requests_update_approver" ON public.requests FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(),'requests:approve:hr') OR public.has_permission(auth.uid(),'requests:approve:lead'))
  WITH CHECK (true);
CREATE POLICY "requests_delete_admin" ON public.requests FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(),'requests:read:all') AND public.has_role(auth.uid(),'super_admin'));

CREATE TRIGGER trg_requests_updated BEFORE UPDATE ON public.requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ request_approvals ============
CREATE TABLE public.request_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  tier public.approval_tier NOT NULL,
  approver_id uuid REFERENCES public.profiles(id),
  decision public.approval_decision NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES public.profiles(id),
  decided_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, tier)
);
CREATE INDEX request_approvals_request_idx ON public.request_approvals(request_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_approvals TO authenticated;
GRANT ALL ON public.request_approvals TO service_role;
ALTER TABLE public.request_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "request_approvals_select" ON public.request_approvals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.requests r WHERE r.id = request_id AND (
      r.user_id = auth.uid()
      OR public.has_permission(auth.uid(),'requests:read:all')
      OR (public.has_permission(auth.uid(),'requests:read:team') AND public.is_work_lead_of(r.user_id, auth.uid()))
      OR approver_id = auth.uid())));
CREATE POLICY "request_approvals_insert" ON public.request_approvals FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.requests r WHERE r.id = request_id AND r.user_id = auth.uid())
    OR public.has_permission(auth.uid(),'requests:approve:hr'));
CREATE POLICY "request_approvals_update_lead" ON public.request_approvals FOR UPDATE TO authenticated
  USING (tier = 'lead' AND approver_id = auth.uid() AND public.has_permission(auth.uid(),'requests:approve:lead'))
  WITH CHECK (tier = 'lead' AND approver_id = auth.uid());
CREATE POLICY "request_approvals_update_hr" ON public.request_approvals FOR UPDATE TO authenticated
  USING (tier = 'hr' AND public.has_permission(auth.uid(),'requests:approve:hr'))
  WITH CHECK (tier = 'hr');
CREATE POLICY "request_approvals_delete_none" ON public.request_approvals FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'super_admin'));

-- ============ review_events ============
CREATE TABLE public.review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('task_entry','eod_report','request')),
  entity_id uuid NOT NULL,
  subject_user_id uuid NOT NULL REFERENCES public.profiles(id),
  action public.review_action NOT NULL,
  note text,
  reviewer_id uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_events_entity_idx ON public.review_events(entity_type, entity_id);
CREATE INDEX review_events_subject_idx ON public.review_events(subject_user_id, created_at DESC);

GRANT SELECT, INSERT ON public.review_events TO authenticated;
GRANT ALL ON public.review_events TO service_role;
ALTER TABLE public.review_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "review_events_select" ON public.review_events FOR SELECT TO authenticated
  USING (subject_user_id = auth.uid()
    OR reviewer_id = auth.uid()
    OR public.has_permission(auth.uid(),'tasks:read:all')
    OR public.has_permission(auth.uid(),'eod:read:all')
    OR (public.has_permission(auth.uid(),'tasks:review:team') AND public.is_work_lead_of(subject_user_id, auth.uid())));
CREATE POLICY "review_events_insert" ON public.review_events FOR INSERT TO authenticated
  WITH CHECK (reviewer_id = auth.uid()
    AND (public.has_permission(auth.uid(),'tasks:review:team')
      OR public.has_permission(auth.uid(),'eod:review:team')
      OR public.has_permission(auth.uid(),'requests:approve:lead')
      OR public.has_permission(auth.uid(),'requests:approve:hr')));

-- ============ announcements ============
CREATE TABLE public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL DEFAULT 'everyone',
  published boolean NOT NULL DEFAULT true,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcements TO authenticated;
GRANT ALL ON public.announcements TO service_role;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "announcements_select" ON public.announcements FOR SELECT TO authenticated
  USING (published OR public.has_permission(auth.uid(),'announcements:manage:all'));
CREATE POLICY "announcements_insert" ON public.announcements FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(),'announcements:manage:all') AND created_by = auth.uid());
CREATE POLICY "announcements_update" ON public.announcements FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(),'announcements:manage:all')) WITH CHECK (true);
CREATE POLICY "announcements_delete" ON public.announcements FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(),'announcements:manage:all'));

CREATE TRIGGER trg_announcements_updated BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();