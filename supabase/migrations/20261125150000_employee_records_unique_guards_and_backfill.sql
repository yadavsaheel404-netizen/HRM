-- Migration: 20261125150000_employee_records_unique_guards_and_backfill.sql
-- Description: Non-destructive additive migration that:
--   1. Adds database-level partial unique indexes on normalized TAS Employee ID and Organization Email
--      in public.employee_records to guarantee duplicate imports are rejected even under concurrency.
--   2. Extends employee_record_import_rows.outcome CHECK constraint to record 'duplicate' explicitly.
--   3. Safely backfills existing non-protected Workforce profiles into public.employee_records
--      using the idempotent sync_all_workforce_to_employee_records() function without overwriting
--      or deleting any existing employee data.

-- 1. Partial unique index on non-empty TAS Employee ID (case-insensitive, trimmed)
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_records_tas_code
  ON public.employee_records (upper(btrim(tas_employee_code)))
  WHERE tas_employee_code IS NOT NULL AND btrim(tas_employee_code) <> '';

-- 2. Partial unique index on non-empty Organization Email (case-insensitive, trimmed)
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_records_org_email
  ON public.employee_records (lower(btrim(organization_email)))
  WHERE organization_email IS NOT NULL AND btrim(organization_email) <> '';

-- 3. Non-destructive CHECK update to record 'duplicate' outcome explicitly
ALTER TABLE public.employee_record_import_rows
  DROP CONSTRAINT IF EXISTS employee_record_import_rows_outcome_check;

ALTER TABLE public.employee_record_import_rows
  ADD CONSTRAINT employee_record_import_rows_outcome_check
  CHECK (
    outcome IN (
      'linked_workforce',
      'created_historical',
      'updated_historical',
      'duplicate',
      'needs_review',
      'skipped',
      'excluded',
      'error'
    )
  );

-- 4. Safe, idempotent backfill of existing non-protected Workforce profiles
--    Preserves all existing Workforce data, documents, and employment history.
SELECT public.sync_all_workforce_to_employee_records(NULL);
