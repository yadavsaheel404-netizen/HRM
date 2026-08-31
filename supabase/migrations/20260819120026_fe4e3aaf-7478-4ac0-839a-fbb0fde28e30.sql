INSERT INTO public.permissions (key, resource, action, scope, description) VALUES
  ('automation:run:all', 'automation', 'run', 'all', 'Trigger and configure scheduled automation'),
  ('import:manage:all', 'import', 'manage', 'all', 'Run the legacy attendance importer')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key) VALUES
  ('super_admin', 'automation:run:all'),
  ('admin', 'automation:run:all'),
  ('super_admin', 'import:manage:all'),
  ('admin', 'import:manage:all'),
  ('hr', 'import:manage:all')
ON CONFLICT DO NOTHING;

CREATE TABLE public.automation_settings (
  id text PRIMARY KEY DEFAULT 'default',
  no_checkin_cutoff time NOT NULL DEFAULT '11:00',
  reminder_interval_minutes integer NOT NULL DEFAULT 90,
  missed_checkout_grace_hours integer NOT NULL DEFAULT 6,
  eod_lock_hours integer NOT NULL DEFAULT 48,
  low_productivity_pct numeric NOT NULL DEFAULT 60,
  high_rejection_pct numeric NOT NULL DEFAULT 10,
  uncovered_ratio_pct numeric NOT NULL DEFAULT 25,
  lookback_days integer NOT NULL DEFAULT 3,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_settings_singleton CHECK (id = 'default')
);
GRANT SELECT, INSERT, UPDATE ON public.automation_settings TO authenticated;
GRANT ALL ON public.automation_settings TO service_role;
ALTER TABLE public.automation_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "automation_settings_read" ON public.automation_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "automation_settings_insert" ON public.automation_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(auth.uid(), 'automation:run:all'));
CREATE POLICY "automation_settings_update" ON public.automation_settings
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'automation:run:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'automation:run:all'));
CREATE TRIGGER trg_automation_settings_updated BEFORE UPDATE ON public.automation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.automation_settings (id) VALUES ('default') ON CONFLICT DO NOTHING;

CREATE TABLE public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  trigger_source text NOT NULL DEFAULT 'cron',
  skipped boolean NOT NULL DEFAULT false,
  reason text,
  flags_created integer NOT NULL DEFAULT 0,
  notifications_sent integer NOT NULL DEFAULT 0,
  days_scanned integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT ON public.automation_runs TO authenticated;
GRANT ALL ON public.automation_runs TO service_role;
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "automation_runs_read" ON public.automation_runs
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'automation:run:all')
      OR public.has_permission(auth.uid(), 'analytics:read:all'));

CREATE TABLE public.automation_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  day_id uuid REFERENCES public.attendance_days(id) ON DELETE CASCADE,
  severity text NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id uuid REFERENCES public.automation_runs(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_flags_unique UNIQUE (rule, user_id, work_date)
);
GRANT SELECT, DELETE ON public.automation_flags TO authenticated;
GRANT ALL ON public.automation_flags TO service_role;
ALTER TABLE public.automation_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "automation_flags_read_self" ON public.automation_flags
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "automation_flags_read_team" ON public.automation_flags
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'attendance:read:team')
         AND public.is_work_lead_of(user_id, auth.uid()));
CREATE POLICY "automation_flags_read_all" ON public.automation_flags
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'attendance:read:all'));
CREATE POLICY "automation_flags_delete_admin" ON public.automation_flags
  FOR DELETE TO authenticated USING (public.has_permission(auth.uid(), 'automation:run:all'));
CREATE INDEX idx_automation_flags_date ON public.automation_flags (work_date DESC);

CREATE TABLE public.org_calendar_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('weekly_off', 'holiday')),
  label text,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_org_calendar_unique
  ON public.org_calendar_days (calendar_date, kind, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_calendar_days TO authenticated;
GRANT ALL ON public.org_calendar_days TO service_role;
ALTER TABLE public.org_calendar_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_calendar_read" ON public.org_calendar_days
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "org_calendar_insert" ON public.org_calendar_days
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(auth.uid(), 'org:manage:all'));
CREATE POLICY "org_calendar_update" ON public.org_calendar_days
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'org:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'org:manage:all'));
CREATE POLICY "org_calendar_delete" ON public.org_calendar_days
  FOR DELETE TO authenticated USING (public.has_permission(auth.uid(), 'org:manage:all'));

CREATE TABLE public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'inspecting'
    CHECK (status IN ('inspecting', 'mapping', 'preview', 'committed', 'cancelled')),
  sheet_names text[] NOT NULL DEFAULT '{}',
  date_from date,
  date_to date,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES public.profiles(id),
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  sheet_name text NOT NULL,
  row_index integer NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  raw_name text,
  raw_identifier text,
  raw_doj text,
  raw_lwd text,
  parsed_doj date,
  parsed_lwd date,
  date_issues jsonb NOT NULL DEFAULT '{}'::jsonb,
  match_state text NOT NULL DEFAULT 'needs_mapping'
    CHECK (match_state IN ('matched', 'needs_mapping', 'new_account')),
  match_reason text,
  matched_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolution text NOT NULL DEFAULT 'pending'
    CHECK (resolution IN ('pending', 'mapped', 'create_new', 'skipped')),
  invitation_id uuid REFERENCES public.invitations(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.import_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  row_id uuid NOT NULL REFERENCES public.import_rows(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  raw_value text,
  mapped_kind text NOT NULL
    CHECK (mapped_kind IN ('attendance', 'calendar', 'signal', 'blank', 'invalid')),
  work_mode attendance_work_mode,
  exception_type day_exception,
  half_day boolean NOT NULL DEFAULT false,
  calendar_kind text,
  signal_type text,
  state text NOT NULL DEFAULT 'valid'
    CHECK (state IN ('valid', 'needs_review', 'conflict', 'resolved', 'skipped')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.import_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  row_id uuid NOT NULL REFERENCES public.import_rows(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('exit', 'reassignment')),
  effective_date date NOT NULL,
  raw_value text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  handled_by uuid REFERENCES public.profiles(id),
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_import_rows_batch ON public.import_rows (batch_id);
CREATE INDEX idx_import_cells_row ON public.import_cells (row_id);
CREATE UNIQUE INDEX idx_import_cells_unique ON public.import_cells (row_id, work_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_rows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_cells TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_signals TO authenticated;
GRANT ALL ON public.import_batches TO service_role;
GRANT ALL ON public.import_rows TO service_role;
GRANT ALL ON public.import_cells TO service_role;
GRANT ALL ON public.import_signals TO service_role;

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_batches_read" ON public.import_batches
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_batches_insert" ON public.import_batches
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_batches_update" ON public.import_batches
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'import:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_batches_delete" ON public.import_batches
  FOR DELETE TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));

CREATE POLICY "import_rows_read" ON public.import_rows
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_rows_insert" ON public.import_rows
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_rows_update" ON public.import_rows
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'import:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_rows_delete" ON public.import_rows
  FOR DELETE TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));

CREATE POLICY "import_cells_read" ON public.import_cells
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_cells_insert" ON public.import_cells
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_cells_update" ON public.import_cells
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'import:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_cells_delete" ON public.import_cells
  FOR DELETE TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));

CREATE POLICY "import_signals_read" ON public.import_signals
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_signals_insert" ON public.import_signals
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_signals_update" ON public.import_signals
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'import:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'import:manage:all'));
CREATE POLICY "import_signals_delete" ON public.import_signals
  FOR DELETE TO authenticated USING (public.has_permission(auth.uid(), 'import:manage:all'));

CREATE TRIGGER trg_import_batches_updated BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_import_rows_updated BEFORE UPDATE ON public.import_rows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.attendance_days
  ADD COLUMN source text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'import')),
  ADD COLUMN import_batch_id uuid REFERENCES public.import_batches(id) ON DELETE SET NULL;
CREATE INDEX idx_attendance_days_source ON public.attendance_days (source, work_date DESC);