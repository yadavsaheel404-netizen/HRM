-- ============================================================================
-- Migration: Custom Template Document Mode & Controlled DOCX Field Mappings
-- Additive, idempotent upgrade to preserve all existing templates & batches.
-- ============================================================================

ALTER TABLE public.custom_email_templates
  ADD COLUMN IF NOT EXISTS document_mode text NOT NULL DEFAULT 'personalized'
    CHECK (document_mode IN ('static', 'personalized')),
  ADD COLUMN IF NOT EXISTS field_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS requires_relieving_approval boolean NOT NULL DEFAULT false;

ALTER TABLE public.custom_email_template_versions
  ADD COLUMN IF NOT EXISTS document_mode text NOT NULL DEFAULT 'personalized',
  ADD COLUMN IF NOT EXISTS field_mappings jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.email_dispatch_items
  ADD COLUMN IF NOT EXISTS template_version integer,
  ADD COLUMN IF NOT EXISTS attachment_sha256 text;
