-- Daily production summary, shift journal, and rainfall.
BEGIN;

CREATE TABLE IF NOT EXISTS public.field_ops_campaigns (
  id text PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name text NOT NULL,
  plan_area numeric NOT NULL DEFAULT 0 CHECK (plan_area >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id uuid
);
CREATE INDEX IF NOT EXISTS field_ops_campaigns_farm_id_idx ON public.field_ops_campaigns(farm_id);

CREATE TABLE IF NOT EXISTS public.field_ops_shift_logs (
  id text PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('day','night')),
  campaign_id text NOT NULL REFERENCES public.field_ops_campaigns(id) ON DELETE CASCADE,
  aggregate_count integer NOT NULL DEFAULT 0 CHECK (aggregate_count >= 0),
  field_entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id uuid,
  UNIQUE (farm_id, campaign_id, work_date, shift)
);
CREATE INDEX IF NOT EXISTS field_ops_shift_logs_farm_date_idx ON public.field_ops_shift_logs(farm_id, work_date);

CREATE TABLE IF NOT EXISTS public.field_ops_rainfall (
  id text PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  settlement text NOT NULL,
  amount_mm numeric NOT NULL DEFAULT 0 CHECK (amount_mm >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id uuid,
  UNIQUE (farm_id, work_date, settlement)
);
CREATE INDEX IF NOT EXISTS field_ops_rainfall_farm_date_idx ON public.field_ops_rainfall(farm_id, work_date);

ALTER TABLE public.field_ops_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_ops_shift_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_ops_rainfall ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_ops_campaigns_read ON public.field_ops_campaigns;
DROP POLICY IF EXISTS field_ops_campaigns_insert ON public.field_ops_campaigns;
DROP POLICY IF EXISTS field_ops_campaigns_update ON public.field_ops_campaigns;
CREATE POLICY field_ops_campaigns_read ON public.field_ops_campaigns FOR SELECT TO authenticated USING (private.field_ops_has_role(farm_id));
CREATE POLICY field_ops_campaigns_insert ON public.field_ops_campaigns FOR INSERT TO authenticated WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));
CREATE POLICY field_ops_campaigns_update ON public.field_ops_campaigns FOR UPDATE TO authenticated USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist'])) WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));

DROP POLICY IF EXISTS field_ops_shift_logs_read ON public.field_ops_shift_logs;
DROP POLICY IF EXISTS field_ops_shift_logs_write ON public.field_ops_shift_logs;
DROP POLICY IF EXISTS field_ops_shift_logs_update ON public.field_ops_shift_logs;
CREATE POLICY field_ops_shift_logs_read ON public.field_ops_shift_logs FOR SELECT TO authenticated USING (private.field_ops_has_role(farm_id));
CREATE POLICY field_ops_shift_logs_write ON public.field_ops_shift_logs FOR INSERT TO authenticated WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));
CREATE POLICY field_ops_shift_logs_update ON public.field_ops_shift_logs FOR UPDATE TO authenticated USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist'])) WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));

DROP POLICY IF EXISTS field_ops_rainfall_read ON public.field_ops_rainfall;
DROP POLICY IF EXISTS field_ops_rainfall_write ON public.field_ops_rainfall;
DROP POLICY IF EXISTS field_ops_rainfall_update ON public.field_ops_rainfall;
CREATE POLICY field_ops_rainfall_read ON public.field_ops_rainfall FOR SELECT TO authenticated USING (private.field_ops_has_role(farm_id));
CREATE POLICY field_ops_rainfall_write ON public.field_ops_rainfall FOR INSERT TO authenticated WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));
CREATE POLICY field_ops_rainfall_update ON public.field_ops_rainfall FOR UPDATE TO authenticated USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist'])) WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));

GRANT SELECT, INSERT, UPDATE ON public.field_ops_campaigns, public.field_ops_shift_logs, public.field_ops_rainfall TO authenticated;

DO $journal_publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.field_ops_campaigns;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.field_ops_shift_logs;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.field_ops_rainfall;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$journal_publication$;

COMMIT;

