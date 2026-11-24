-- Migration: 20261125000000_employee_relieving_and_experience_letters.sql
-- Description: Dedicated Employee Relieving & Experience Letter module with audit tracking and document storage.

-- 1. Create public.relieving_cases table
create table if not exists public.relieving_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'relieved', 'rejected', 'cancelled')),
  employee_name text not null,
  employee_code text,
  work_email text not null,
  designation text not null,
  department_id uuid references public.departments(id) on delete set null,
  department_name text,
  employment_category text not null default 'intern',
  legal_employer text not null default 'Learning Paths Technologies LLP',
  joining_date date not null,
  last_working_day date not null,
  relieving_effective_date date not null,
  letter_issue_date date not null default current_date,
  relieving_reason text not null default 'Tenure completion',
  contributed_projects text not null default 'Core projects and initiatives',
  performance_statement text not null default 'satisfactory',
  handover_status text not null default 'completed' check (handover_status in ('pending', 'in_progress', 'completed', 'waived')),
  project_clearance boolean not null default true,
  asset_clearance boolean not null default true,
  signatory_name text not null default 'K. Spandana',
  signatory_title text not null default 'HR - Director',
  signatory_designation text not null default 'Director',
  company_contact text not null default '+91 92468 18843',
  company_address text not null default 'T-hub 2.0, Knowledge City, Hyderabad, Telangana',
  hr_notes text,
  checklist_handover boolean not null default true,
  checklist_assets boolean not null default true,
  checklist_access_revocation boolean not null default true,
  checklist_dues_cleared boolean not null default true,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  relieved_by uuid references public.profiles(id) on delete set null,
  relieved_at timestamptz,
  letter_pdf_path text,
  letter_pdf_hash text,
  email_status text not null default 'not_sent' check (email_status in ('not_sent', 'queued', 'accepted_by_smtp', 'failed', 'delivered')),
  email_sent_at timestamptz,
  email_message_id text,
  email_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexing for high-performance lookup
create index if not exists idx_relieving_cases_user_id on public.relieving_cases(user_id);
create index if not exists idx_relieving_cases_status on public.relieving_cases(status);
create index if not exists idx_relieving_cases_created_at on public.relieving_cases(created_at desc);

-- Automatic updated_at trigger
create or replace function public.set_relieving_cases_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_relieving_cases_updated_at on public.relieving_cases;
create trigger trg_set_relieving_cases_updated_at
before update on public.relieving_cases
for each row execute function public.set_relieving_cases_updated_at();

-- 2. Insert new permissions into public.permissions
insert into public.permissions (key, resource, action, scope, description) values
  ('relieving:read:all', 'relieving', 'read', 'all', 'View all employee relieving records and experience letters'),
  ('relieving:manage:all', 'relieving', 'manage', 'all', 'Create, update, and manage relieving cases and clearance checklists'),
  ('relieving:approve:all', 'relieving', 'approve', 'all', 'Formally approve employee relieving cases and final relieving actions'),
  ('relieving:send:all', 'relieving', 'send', 'all', 'Send official relieving and experience letters via Hostinger SMTP'),
  ('relieving:read:self', 'relieving', 'read', 'self', 'View own approved relieving record and download official experience letter')
on conflict (key) do update set description = excluded.description;

-- Insert into role_permissions
insert into public.role_permissions (role, permission_key)
values
  ('super_admin'::public.app_role, 'relieving:read:all'),
  ('super_admin'::public.app_role, 'relieving:manage:all'),
  ('super_admin'::public.app_role, 'relieving:approve:all'),
  ('super_admin'::public.app_role, 'relieving:send:all'),
  ('super_admin'::public.app_role, 'relieving:read:self'),
  ('hr'::public.app_role, 'relieving:read:all'),
  ('hr'::public.app_role, 'relieving:manage:all'),
  ('hr'::public.app_role, 'relieving:approve:all'),
  ('hr'::public.app_role, 'relieving:send:all'),
  ('hr'::public.app_role, 'relieving:read:self'),
  ('admin'::public.app_role, 'relieving:read:all'),
  ('admin'::public.app_role, 'relieving:read:self'),
  ('manager'::public.app_role, 'relieving:read:self'),
  ('lead'::public.app_role, 'relieving:read:self'),
  ('employee'::public.app_role, 'relieving:read:self')
on conflict (role, permission_key) do nothing;

-- 3. Row Level Security on relieving_cases
alter table public.relieving_cases enable row level security;

drop policy if exists relieving_cases_admin_hr_all on public.relieving_cases;
create policy relieving_cases_admin_hr_all on public.relieving_cases
for all
to authenticated
using (
  exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('super_admin', 'hr', 'admin')
  )
)
with check (
  exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('super_admin', 'hr')
  )
);

drop policy if exists relieving_cases_self_read on public.relieving_cases;
create policy relieving_cases_self_read on public.relieving_cases
for select
to authenticated
using (
  user_id = auth.uid()
  and status in ('approved', 'relieved')
);

-- 4. Create storage bucket for relieving documents if storage schema exists
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('relieving-documents', 'relieving-documents', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- Storage policies for relieving-documents
drop policy if exists "HR and Super Admin can manage relieving documents" on storage.objects;
create policy "HR and Super Admin can manage relieving documents" on storage.objects
for all
to authenticated
using (
  bucket_id = 'relieving-documents'
  and exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('super_admin', 'hr', 'admin')
  )
)
with check (
  bucket_id = 'relieving-documents'
  and exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('super_admin', 'hr')
  )
);

drop policy if exists "Employees can read their own relieving letter" on storage.objects;
create policy "Employees can read their own relieving letter" on storage.objects
for select
to authenticated
using (
  bucket_id = 'relieving-documents'
  and exists (
    select 1 from public.relieving_cases rc
    where rc.letter_pdf_path = name
      and rc.user_id = auth.uid()
      and rc.status in ('approved', 'relieved')
  )
);
