ALTER TABLE public.task_entries ADD COLUMN IF NOT EXISTS units_assigned numeric;

CREATE TABLE IF NOT EXISTS public.office_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  latitude numeric NOT NULL,
  longitude numeric NOT NULL,
  radius_meters integer NOT NULL DEFAULT 70,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.office_locations TO authenticated;
GRANT ALL ON public.office_locations TO service_role;

ALTER TABLE public.office_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "office_locations_read" ON public.office_locations;
CREATE POLICY "office_locations_read" ON public.office_locations
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "office_locations_insert" ON public.office_locations;
CREATE POLICY "office_locations_insert" ON public.office_locations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'org:manage:all'));

DROP POLICY IF EXISTS "office_locations_update" ON public.office_locations;
CREATE POLICY "office_locations_update" ON public.office_locations
  FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'org:manage:all'))
  WITH CHECK (public.has_permission(auth.uid(), 'org:manage:all'));

DROP POLICY IF EXISTS "office_locations_delete" ON public.office_locations;
CREATE POLICY "office_locations_delete" ON public.office_locations
  FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'org:manage:all'));

DROP TRIGGER IF EXISTS trg_office_locations_updated ON public.office_locations;
CREATE TRIGGER trg_office_locations_updated
  BEFORE UPDATE ON public.office_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.office_locations (name, address, latitude, longitude, radius_meters, is_active)
SELECT 'AV HUB', NULL, 17.440396, 78.386981, 70, true
WHERE NOT EXISTS (SELECT 1 FROM public.office_locations WHERE name = 'AV HUB');

ALTER TABLE public.attendance_days
  ADD COLUMN IF NOT EXISTS location_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS location_latitude numeric,
  ADD COLUMN IF NOT EXISTS location_longitude numeric,
  ADD COLUMN IF NOT EXISTS location_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS location_distance_m numeric,
  ADD COLUMN IF NOT EXISTS office_location_id uuid REFERENCES public.office_locations(id);

CREATE OR REPLACE FUNCTION public.guard_attendance_self_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE caller uuid := auth.uid();
BEGIN
  IF caller IS NULL OR public.has_permission(caller, 'attendance:read:all') THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.exception_type IS DISTINCT FROM OLD.exception_type
     OR NEW.exception_note IS DISTINCT FROM OLD.exception_note
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
    RAISE EXCEPTION 'Only an administrator can change these attendance details.';
  END IF;

  -- required_minutes is derived from allocations at check-in only
  IF NEW.required_minutes IS DISTINCT FROM OLD.required_minutes AND OLD.check_in_at IS NOT NULL THEN
    RAISE EXCEPTION 'Required hours cannot be changed after check-in.';
  END IF;

  -- location evidence is captured at check-in and is immutable afterwards
  IF OLD.check_in_at IS NOT NULL AND (
       NEW.location_status IS DISTINCT FROM OLD.location_status
       OR NEW.location_latitude IS DISTINCT FROM OLD.location_latitude
       OR NEW.location_longitude IS DISTINCT FROM OLD.location_longitude
       OR NEW.location_accuracy_m IS DISTINCT FROM OLD.location_accuracy_m
       OR NEW.location_distance_m IS DISTINCT FROM OLD.location_distance_m
       OR NEW.office_location_id IS DISTINCT FROM OLD.office_location_id
     ) THEN
    RAISE EXCEPTION 'Check-in location evidence cannot be changed after check-in.';
  END IF;

  RETURN NEW;
END;
$function$;