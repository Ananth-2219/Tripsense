-- Apply separately as the project database owner (for example SQL Editor).
-- This migration deliberately does not ALTER, UPDATE or DELETE public.trips.
-- Existing app uses the anon role without Supabase Auth accounts. A new trip
-- carries a SHA-256 hash of a 256-bit random per-trip capability in metadata.
BEGIN;

-- Reuse the table/column names found in the final live schema inspection.
-- IF NOT EXISTS also supports a fresh local installation; no duplicate table.
CREATE TABLE IF NOT EXISTS public.trip_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL UNIQUE REFERENCES public.trips(id) ON DELETE CASCADE,
  phone_placement text,
  phone_movement text,
  road_condition text,
  traffic_condition text,
  perceived_smoothness text,
  reported_maneuvers text,
  unusual_event text,
  comments text,
  submitted_at timestamptz DEFAULT now()
);
-- NOT VALID preserves existing (possibly incomplete) feedback without backfill,
-- while PostgreSQL enforces these checks for every new insert/update.
ALTER TABLE public.trip_feedback
  ADD CONSTRAINT trip_feedback_valid_phone_placement CHECK (phone_placement IS NOT NULL AND phone_placement IN ('mount','hand','pocket','bag','other','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_phone_movement CHECK (phone_movement IS NOT NULL AND phone_movement IN ('still','slight_movement','frequent_movement','picked_up','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_road_condition CHECK (road_condition IS NOT NULL AND road_condition IN ('smooth','mixed','rough','unpaved','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_traffic_condition CHECK (traffic_condition IS NOT NULL AND traffic_condition IN ('light','moderate','heavy','stop_go','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_smoothness CHECK (perceived_smoothness IS NOT NULL AND perceived_smoothness IN ('very_smooth','mostly_smooth','mixed','rough','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_maneuvers CHECK (reported_maneuvers IS NOT NULL AND reported_maneuvers IN ('none','braking','acceleration','turning','multiple','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_unusual_event CHECK (unusual_event IS NOT NULL AND unusual_event IN ('none','pothole','phone_handling','near_miss','detour','other','unsure')) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_comments CHECK (comments IS NOT NULL AND char_length(comments) <= 1000) NOT VALID,
  ADD CONSTRAINT trip_feedback_valid_submission CHECK (submitted_at IS NOT NULL) NOT VALID;
COMMENT ON TABLE public.trip_feedback IS 'Subjective rider questionnaire v1; never a sensor label or driving score.';
ALTER TABLE public.trip_feedback ENABLE ROW LEVEL SECURITY;
-- Intentionally no direct client policies: default-deny RLS plus revoked grants.
-- Clients cannot enumerate, insert, update or delete feedback through the table.
REVOKE ALL ON public.trip_feedback FROM PUBLIC, anon, authenticated;

-- These two narrowly scoped definer functions are necessary because the
-- existing anon role has INSERT-only access to trips. They never return raw
-- readings, metadata, tokens or answers; UUID alone conveys no access.
CREATE FUNCTION public.trip_feedback_state(p_trip_id uuid, p_feedback_token text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_feedback_token IS NULL OR p_feedback_token !~ '^[0-9a-f]{64}$' THEN
    RETURN 'missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.trips t WHERE t.id = p_trip_id AND t.ended_at IS NOT NULL
      AND t.metadata->>'feedback_token_hash' =
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_feedback_token, 'UTF8')), 'hex')
  ) THEN
    RETURN 'missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trip_feedback f WHERE f.trip_id = p_trip_id) THEN
    RETURN 'submitted';
  END IF;
  RETURN 'trip_saved';
END;
$$;

CREATE FUNCTION public.submit_trip_feedback(
  p_trip_id uuid, p_feedback_token text, p_answers jsonb, p_comments text DEFAULT ''
)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE saved_at timestamptz;
BEGIN
  IF public.trip_feedback_state(p_trip_id, p_feedback_token) = 'missing' THEN
    RAISE EXCEPTION 'Trip feedback not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_answers IS NULL OR pg_catalog.jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'Exactly seven answers required' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_answers)) <> 7
      OR NOT (p_answers ?& ARRAY['phone_placement','phone_stability','road_conditions',
                                'traffic_conditions','driving_smoothness','sudden_maneuvers','unusual_events']) THEN
    RAISE EXCEPTION 'Exactly seven answers required' USING ERRCODE = '22023';
  END IF;
  -- Validate even on retries: ON CONFLICT alone would skip CHECK constraints.
  IF p_answers->>'phone_placement' IS NULL OR p_answers->>'phone_placement' NOT IN ('mount','hand','pocket','bag','other','unsure')
    OR p_answers->>'phone_stability' IS NULL OR p_answers->>'phone_stability' NOT IN ('still','slight_movement','frequent_movement','picked_up','unsure')
    OR p_answers->>'road_conditions' IS NULL OR p_answers->>'road_conditions' NOT IN ('smooth','mixed','rough','unpaved','unsure')
    OR p_answers->>'traffic_conditions' IS NULL OR p_answers->>'traffic_conditions' NOT IN ('light','moderate','heavy','stop_go','unsure')
    OR p_answers->>'driving_smoothness' IS NULL OR p_answers->>'driving_smoothness' NOT IN ('very_smooth','mostly_smooth','mixed','rough','unsure')
    OR p_answers->>'sudden_maneuvers' IS NULL OR p_answers->>'sudden_maneuvers' NOT IN ('none','braking','acceleration','turning','multiple','unsure')
    OR p_answers->>'unusual_events' IS NULL OR p_answers->>'unusual_events' NOT IN ('none','pothole','phone_handling','near_miss','detour','other','unsure')
    OR p_comments IS NULL OR char_length(p_comments) > 1000 THEN
    RAISE EXCEPTION 'Invalid questionnaire answer or comments' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.trip_feedback(trip_id,phone_placement,phone_movement,road_condition,
    traffic_condition,perceived_smoothness,reported_maneuvers,unusual_event,comments,submitted_at)
  VALUES(p_trip_id,p_answers->>'phone_placement',p_answers->>'phone_stability',p_answers->>'road_conditions',
    p_answers->>'traffic_conditions',p_answers->>'driving_smoothness',p_answers->>'sudden_maneuvers',
    p_answers->>'unusual_events',p_comments,now())
  ON CONFLICT (trip_id) DO NOTHING;
  SELECT f.submitted_at INTO saved_at FROM public.trip_feedback f WHERE f.trip_id = p_trip_id;
  RETURN saved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.trip_feedback_state(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_trip_feedback(uuid,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_feedback_state(uuid,text) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_trip_feedback(uuid,text,jsonb,text) TO anon;
COMMIT;
