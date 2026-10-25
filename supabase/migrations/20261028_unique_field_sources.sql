-- Prevent repeated KML imports or concurrent devices from creating duplicate
-- field records for the same source identifier within one farm.
BEGIN;

DO $$
DECLARE duplicate_groups integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_groups
  FROM (
    SELECT farm_id, lower(btrim(source_id)) AS normalized_source_id
    FROM public.field_ops_fields
    GROUP BY farm_id, lower(btrim(source_id))
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION 'Cannot add unique field-source index: % duplicate groups remain', duplicate_groups;
  END IF;
END $$;

ALTER TABLE public.field_ops_fields
  ADD COLUMN IF NOT EXISTS normalized_source_id text
  GENERATED ALWAYS AS (lower(btrim(source_id))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS field_ops_fields_farm_source_uidx
  ON public.field_ops_fields (farm_id, normalized_source_id);

NOTIFY pgrst, 'reload schema';

COMMIT;
