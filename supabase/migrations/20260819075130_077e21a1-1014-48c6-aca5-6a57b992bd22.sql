CREATE TYPE public.blocker_severity AS ENUM ('low','medium','high','critical');

ALTER TABLE public.blockers ALTER COLUMN severity DROP DEFAULT;
UPDATE public.blockers SET severity = 'medium'
  WHERE severity NOT IN ('low','medium','high','critical');
ALTER TABLE public.blockers
  ALTER COLUMN severity TYPE public.blocker_severity USING severity::public.blocker_severity;
ALTER TABLE public.blockers
  ALTER COLUMN severity SET DEFAULT 'medium'::public.blocker_severity;

CREATE TYPE public.project_shift AS ENUM ('general','morning','evening','night','rotational','flexible');

UPDATE public.projects SET shift = NULL
  WHERE shift IS NOT NULL
    AND shift NOT IN ('general','morning','evening','night','rotational','flexible');
ALTER TABLE public.projects
  ALTER COLUMN shift TYPE public.project_shift USING shift::public.project_shift;

UPDATE public.projects SET task_unit = 'other'
  WHERE task_unit NOT IN ('task','clip','image','video','audio_minute','document','record','annotation','row','other');
ALTER TABLE public.projects
  ADD CONSTRAINT projects_task_unit_known CHECK (
    task_unit IN ('task','clip','image','video','audio_minute','document','record','annotation','row','other')
  );