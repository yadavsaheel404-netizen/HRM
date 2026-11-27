-- ============================================================================
-- Migration: Custom Email Templates (DOCX/PDF) & Durable Bulk Dispatch Queue
-- Safe, additive, idempotent migration — preserves 100% of existing tables,
-- standard templates, relieving approvals, and role permissions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Private Storage Bucket for Uploaded Custom DOCX/PDF Email Templates
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'custom-email-templates',
  'custom-email-templates',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Strict storage RLS: only HR / Super Admin (`emails:manage:all`) may access
-- private custom email template files. Never expose to anon, Founder, or Admin.
DROP POLICY IF EXISTS custom_email_templates_storage_select ON storage.objects;
CREATE POLICY custom_email_templates_storage_select
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'custom-email-templates'
    AND public.has_permission(auth.uid(), 'emails:manage:all')
  );

DROP POLICY IF EXISTS custom_email_templates_storage_insert ON storage.objects;
CREATE POLICY custom_email_templates_storage_insert
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'custom-email-templates'
    AND public.has_permission(auth.uid(), 'emails:manage:all')
  );

DROP POLICY IF EXISTS custom_email_templates_storage_update ON storage.objects;
CREATE POLICY custom_email_templates_storage_update
  ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'custom-email-templates'
    AND public.has_permission(auth.uid(), 'emails:manage:all')
  )
  WITH CHECK (
    bucket_id = 'custom-email-templates'
    AND public.has_permission(auth.uid(), 'emails:manage:all')
  );

DROP POLICY IF EXISTS custom_email_templates_storage_delete ON storage.objects;
CREATE POLICY custom_email_templates_storage_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'custom-email-templates'
    AND public.has_permission(auth.uid(), 'emails:manage:all')
  );

-- ----------------------------------------------------------------------------
-- 2. Custom Email Templates & Version Audit History
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.custom_email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  purpose_category text NOT NULL DEFAULT 'general',
  subject_template text NOT NULL,
  body_html_template text NOT NULL,
  body_text_template text,
  attachment_path text,
  attachment_filename text,
  attachment_format text NOT NULL DEFAULT 'none'
    CHECK (attachment_format IN ('none', 'docx', 'pdf')),
  attachment_mime text,
  attachment_size_bytes integer
    CHECK (attachment_size_bytes IS NULL OR (attachment_size_bytes > 0 AND attachment_size_bytes <= 10485760)),
  attachment_sha256 text,
  pdf_mode text
    CHECK (pdf_mode IS NULL OR pdf_mode IN ('static', 'fillable')),
  detected_placeholders text[] NOT NULL DEFAULT '{}',
  recipient_type text NOT NULL DEFAULT 'all_records'
    CHECK (recipient_type IN ('all_records', 'active_employees', 'former_employees', 'interns_trainers', 'custom')),
  default_email_mode text NOT NULL DEFAULT 'personal'
    CHECK (default_email_mode IN ('personal', 'work')),
  sender_display text NOT NULL DEFAULT 'The AI School HR <hr@theaischool.co>',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'archived')),
  requires_elevated_approval boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_email_templates_status_idx
  ON public.custom_email_templates (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.custom_email_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.custom_email_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name text NOT NULL,
  subject_template text NOT NULL,
  body_html_template text NOT NULL,
  body_text_template text,
  attachment_path text,
  attachment_filename text,
  attachment_format text NOT NULL DEFAULT 'none'
    CHECK (attachment_format IN ('none', 'docx', 'pdf')),
  attachment_sha256 text,
  detected_placeholders text[] NOT NULL DEFAULT '{}',
  status text NOT NULL,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS custom_email_template_versions_tpl_idx
  ON public.custom_email_template_versions (template_id, version DESC);

-- ----------------------------------------------------------------------------
-- 3. Durable Bulk Dispatch Batches & Per-Recipient Items (500+ Support)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_dispatch_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  dispatch_kind text NOT NULL
    CHECK (dispatch_kind IN ('relieving_bulk', 'custom_template_bulk')),
  template_slug text,
  custom_template_id uuid REFERENCES public.custom_email_templates(id) ON DELETE SET NULL,
  template_name text NOT NULL,
  template_version integer,
  subject_template text NOT NULL,
  default_email_mode text NOT NULL DEFAULT 'personal'
    CHECK (default_email_mode IN ('personal', 'work')),
  attachment_filename text,
  attachment_format text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'partial_failure', 'failed', 'canceled')),
  total_count integer NOT NULL DEFAULT 0,
  queued_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  canceled_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  personal_email_count integer NOT NULL DEFAULT 0,
  work_email_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_dispatch_batches_status_idx
  ON public.email_dispatch_batches (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.email_dispatch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.email_dispatch_batches(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  recipient_record_id text NOT NULL,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  relieving_case_id uuid REFERENCES public.relieving_cases(id) ON DELETE SET NULL,
  employee_code text,
  recipient_name text NOT NULL,
  email_mode text NOT NULL
    CHECK (email_mode IN ('personal', 'work')),
  recipient_email text NOT NULL,
  resolved_subject text NOT NULL,
  resolved_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  attachment_name text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'accepted_by_smtp', 'delivered', 'failed', 'canceled', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  provider text NOT NULL DEFAULT 'hostinger_smtp',
  provider_message_id text,
  smtp_response text,
  error_message text,
  email_message_id uuid REFERENCES public.email_messages(id) ON DELETE SET NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_dispatch_items_batch_status_idx
  ON public.email_dispatch_items (batch_id, status, created_at ASC);

-- ----------------------------------------------------------------------------
-- 4. Updated_at Triggers
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_custom_email_templates_updated_at ON public.custom_email_templates;
    CREATE TRIGGER trg_custom_email_templates_updated_at
      BEFORE UPDATE ON public.custom_email_templates
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    DROP TRIGGER IF EXISTS trg_email_dispatch_batches_updated_at ON public.email_dispatch_batches;
    CREATE TRIGGER trg_email_dispatch_batches_updated_at
      BEFORE UPDATE ON public.email_dispatch_batches
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    DROP TRIGGER IF EXISTS trg_email_dispatch_items_updated_at ON public.email_dispatch_items;
    CREATE TRIGGER trg_email_dispatch_items_updated_at
      BEFORE UPDATE ON public.email_dispatch_items
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Privileges & Strict Row-Level Security (RLS)
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE
  public.custom_email_templates,
  public.custom_email_template_versions,
  public.email_dispatch_batches,
  public.email_dispatch_items
FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.custom_email_templates,
  public.custom_email_template_versions,
  public.email_dispatch_batches,
  public.email_dispatch_items
TO authenticated;

GRANT ALL ON TABLE
  public.custom_email_templates,
  public.custom_email_template_versions,
  public.email_dispatch_batches,
  public.email_dispatch_items
TO service_role;

ALTER TABLE public.custom_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_email_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_dispatch_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_dispatch_items ENABLE ROW LEVEL SECURITY;

-- Custom Email Templates:
-- - HR & Super Admin (`emails:manage:all`) can read & manage.
-- - Founder (`emails:read:all` + role = 'founder') has read-only metadata visibility.
-- - Admin has NO default custom-template admin/dispatch access unless granted `emails:manage:all`.
-- - Manager / Lead / Employee are denied completely.
DROP POLICY IF EXISTS custom_email_templates_select ON public.custom_email_templates;
CREATE POLICY custom_email_templates_select
  ON public.custom_email_templates
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'emails:manage:all')
    OR (
      public.has_permission(auth.uid(), 'emails:read:all')
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
      )
    )
  );

DROP POLICY IF EXISTS custom_email_templates_insert ON public.custom_email_templates;
CREATE POLICY custom_email_templates_insert
  ON public.custom_email_templates
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'emails:manage:all'));

DROP POLICY IF EXISTS custom_email_templates_update ON public.custom_email_templates;
CREATE POLICY custom_email_templates_update
  ON public.custom_email_templates
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'emails:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'emails:manage:all'));

DROP POLICY IF EXISTS custom_email_templates_delete ON public.custom_email_templates;
CREATE POLICY custom_email_templates_delete
  ON public.custom_email_templates
  FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'emails:manage:all'));

-- Version History Policies
DROP POLICY IF EXISTS custom_email_template_versions_select ON public.custom_email_template_versions;
CREATE POLICY custom_email_template_versions_select
  ON public.custom_email_template_versions
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'emails:manage:all')
    OR (
      public.has_permission(auth.uid(), 'emails:read:all')
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
      )
    )
  );

DROP POLICY IF EXISTS custom_email_template_versions_insert ON public.custom_email_template_versions;
CREATE POLICY custom_email_template_versions_insert
  ON public.custom_email_template_versions
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'emails:manage:all'));

-- Dispatch Batches Policies (HR/SA write, HR/SA/Founder read)
DROP POLICY IF EXISTS email_dispatch_batches_select ON public.email_dispatch_batches;
CREATE POLICY email_dispatch_batches_select
  ON public.email_dispatch_batches
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'emails:read:all'));

DROP POLICY IF EXISTS email_dispatch_batches_write ON public.email_dispatch_batches;
CREATE POLICY email_dispatch_batches_write
  ON public.email_dispatch_batches
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'emails:send:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'emails:send:all'));

-- Dispatch Items Policies (HR/SA write; Founder blocked from personal emails if admin/non-hr via server projection, RLS checks emails:send:all or emails:read:all)
DROP POLICY IF EXISTS email_dispatch_items_select ON public.email_dispatch_items;
CREATE POLICY email_dispatch_items_select
  ON public.email_dispatch_items
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'emails:send:all')
    OR (
      public.has_permission(auth.uid(), 'emails:read:all')
      AND email_mode = 'work'
    )
  );

DROP POLICY IF EXISTS email_dispatch_items_write ON public.email_dispatch_items;
CREATE POLICY email_dispatch_items_write
  ON public.email_dispatch_items
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'emails:send:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'emails:send:all'));
