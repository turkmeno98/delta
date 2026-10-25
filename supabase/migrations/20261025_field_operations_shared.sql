-- Shared Field Operations app tables. Keeps the legacy agronomy tables intact.
BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.field_ops_has_role(p_farm_id uuid, p_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.farm_members AS fm
    WHERE fm.farm_id = p_farm_id
      AND fm.user_id = auth.uid()
      AND (p_roles IS NULL OR fm.role = ANY (p_roles))
  );
$function$;

CREATE TABLE public.field_ops_fields (
  id text PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  source_id text NOT NULL DEFAULT '',
  name text NOT NULL,
  geometry jsonb NOT NULL,
  area numeric NOT NULL DEFAULT 0,
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  color text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id uuid
);
CREATE INDEX field_ops_fields_farm_id_idx ON public.field_ops_fields(farm_id);

CREATE TABLE public.field_ops_settings (
  farm_id uuid PRIMARY KEY REFERENCES public.farms(id) ON DELETE CASCADE,
  kinds jsonb NOT NULL DEFAULT '[]'::jsonb,
  operation_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  imported_at text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id uuid
);

CREATE TABLE public.field_ops_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  token uuid NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('agronomist', 'operator', 'viewer')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_by uuid REFERENCES auth.users(id),
  accepted_at timestamptz
);
CREATE INDEX field_ops_invites_farm_id_idx ON public.field_ops_invites(farm_id);

ALTER TABLE public.field_ops_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_ops_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_ops_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_ops_fields_read ON public.field_ops_fields
  FOR SELECT TO authenticated USING (private.field_ops_has_role(farm_id));
CREATE POLICY field_ops_fields_write ON public.field_ops_fields
  FOR INSERT TO authenticated WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));
CREATE POLICY field_ops_fields_update ON public.field_ops_fields
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));
CREATE POLICY field_ops_fields_delete ON public.field_ops_fields
  FOR DELETE TO authenticated USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager']));

CREATE POLICY field_ops_settings_read ON public.field_ops_settings
  FOR SELECT TO authenticated USING (private.field_ops_has_role(farm_id));
CREATE POLICY field_ops_settings_write ON public.field_ops_settings
  FOR INSERT TO authenticated WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));
CREATE POLICY field_ops_settings_update ON public.field_ops_settings
  FOR UPDATE TO authenticated
  USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']))
  WITH CHECK (private.field_ops_has_role(farm_id, ARRAY['owner','manager','agronomist']));

CREATE POLICY field_ops_invites_read ON public.field_ops_invites
  FOR SELECT TO authenticated USING (private.field_ops_has_role(farm_id, ARRAY['owner','manager']));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_ops_fields TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.field_ops_settings TO authenticated;
GRANT SELECT ON public.field_ops_invites TO authenticated;
REVOKE ALL ON FUNCTION private.field_ops_has_role(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.field_ops_has_role(uuid, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_field_ops_farm(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_farm_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Требуется вход' USING ERRCODE = '42501'; END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN RAISE EXCEPTION 'Введите название хозяйства' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.farms(name) VALUES (btrim(p_name)) RETURNING id INTO v_farm_id;
  INSERT INTO public.farm_members(farm_id, user_id, role) VALUES (v_farm_id, v_user_id, 'owner');
  RETURN v_farm_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_field_ops_farm(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_field_ops_farm(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_field_ops_invite(p_farm_id uuid, p_token uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.field_ops_has_role(p_farm_id, ARRAY['owner','manager']) THEN
    RAISE EXCEPTION 'Недостаточно прав для приглашения' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('agronomist','operator','viewer') THEN
    RAISE EXCEPTION 'Недопустимая роль участника' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.field_ops_invites(farm_id, token, role, created_by)
  VALUES (p_farm_id, p_token, p_role, auth.uid());
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_field_ops_invite(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_invite public.field_ops_invites%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Сначала войдите в аккаунт' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_invite FROM public.field_ops_invites
  WHERE token = p_token AND accepted_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Приглашение недействительно или истекло' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.farm_members(farm_id, user_id, role)
  VALUES (v_invite.farm_id, v_user_id, v_invite.role)
  ON CONFLICT (farm_id, user_id) DO NOTHING;
  UPDATE public.field_ops_invites SET accepted_by = v_user_id, accepted_at = now() WHERE id = v_invite.id;
  RETURN v_invite.farm_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_field_ops_invite(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_field_ops_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_field_ops_invite(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_field_ops_invite(uuid) TO authenticated;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.field_ops_fields;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.field_ops_settings;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$publication$;

COMMIT;

