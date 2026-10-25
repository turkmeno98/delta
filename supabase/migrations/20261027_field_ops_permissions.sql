-- The UI exposes the operator role as an editor. Keep database permissions in sync.
BEGIN;

DROP POLICY IF EXISTS field_ops_fields_write ON public.field_ops_fields;
DROP POLICY IF EXISTS field_ops_fields_update ON public.field_ops_fields;
CREATE POLICY field_ops_fields_write ON public.field_ops_fields
  FOR INSERT TO authenticated
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));
CREATE POLICY field_ops_fields_update ON public.field_ops_fields
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));

DROP POLICY IF EXISTS field_ops_settings_write ON public.field_ops_settings;
DROP POLICY IF EXISTS field_ops_settings_update ON public.field_ops_settings;
CREATE POLICY field_ops_settings_write ON public.field_ops_settings
  FOR INSERT TO authenticated
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));
CREATE POLICY field_ops_settings_update ON public.field_ops_settings
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));

DROP POLICY IF EXISTS field_ops_campaigns_insert ON public.field_ops_campaigns;
DROP POLICY IF EXISTS field_ops_campaigns_update ON public.field_ops_campaigns;
CREATE POLICY field_ops_campaigns_insert ON public.field_ops_campaigns
  FOR INSERT TO authenticated
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));
CREATE POLICY field_ops_campaigns_update ON public.field_ops_campaigns
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));

DROP POLICY IF EXISTS field_ops_shift_logs_write ON public.field_ops_shift_logs;
DROP POLICY IF EXISTS field_ops_shift_logs_update ON public.field_ops_shift_logs;
CREATE POLICY field_ops_shift_logs_write ON public.field_ops_shift_logs
  FOR INSERT TO authenticated
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));
CREATE POLICY field_ops_shift_logs_update ON public.field_ops_shift_logs
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));

DROP POLICY IF EXISTS field_ops_rainfall_write ON public.field_ops_rainfall;
DROP POLICY IF EXISTS field_ops_rainfall_update ON public.field_ops_rainfall;
CREATE POLICY field_ops_rainfall_write ON public.field_ops_rainfall
  FOR INSERT TO authenticated
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));
CREATE POLICY field_ops_rainfall_update ON public.field_ops_rainfall
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist','operator']));

COMMIT;
