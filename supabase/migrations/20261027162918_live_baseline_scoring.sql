-- Phase2: reviewed, service-only RPCs. Apply manually as database owner.
-- Existing tables, RLS, browser grants, raw historical rows and policies stay intact.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.trip_scores') IS NULL THEN
    RAISE EXCEPTION 'Inspect/install the verified trips and trip_scores schemas first';
  END IF;
END $$;

CREATE FUNCTION public._live_score_authorize(p_trip_id uuid,p_feedback_token text)
RETURNS public.trips LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$ DECLARE t public.trips; BEGIN
  IF p_feedback_token IS NULL OR p_feedback_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Trip access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO t FROM public.trips WHERE id=p_trip_id;
  IF NOT FOUND OR t.ended_at IS NULL OR t.metadata->>'feedback_token_hash' IS DISTINCT FROM
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_feedback_token,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'Trip access denied' USING ERRCODE='42501';
  END IF;
  RETURN t;
END $$;
REVOKE ALL ON FUNCTION public._live_score_authorize(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.live_baseline_get(p_trip_id uuid,p_feedback_token text,p_include_readings boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$ DECLARE t public.trips; s public.trip_scores; BEGIN
  t:=public._live_score_authorize(p_trip_id,p_feedback_token);
  SELECT * INTO s FROM public.trip_scores WHERE trip_id=p_trip_id AND policy_version='experimental-ride-smoothness/1.0.0';
  RETURN pg_catalog.jsonb_build_object('trip',pg_catalog.to_jsonb(t)-'readings'-'metadata',
    'readings',CASE WHEN p_include_readings THEN t.readings ELSE NULL END,
    'score',CASE WHEN s.id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(s) END);
END $$;

CREATE FUNCTION public.live_baseline_ingest(p_trip jsonb,p_feedback_token text,p_input_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE t public.trips; trip_uuid uuid; token_hash text; meta jsonb; BEGIN
  IF p_feedback_token IS NULL OR p_feedback_token !~ '^[0-9a-f]{64}$'
    OR p_input_fingerprint IS NULL OR p_input_fingerprint !~ '^[0-9a-f]{64}$'
    OR pg_catalog.jsonb_typeof(p_trip)<>'object' OR pg_catalog.jsonb_typeof(p_trip->'readings') IS DISTINCT FROM 'array'
    OR pg_catalog.octet_length(p_trip::text)>8388608
    OR (p_trip->>'duration_seconds')::double precision NOT BETWEEN 0 AND 1800
    OR (p_trip->>'motion_count')::integer<0 OR (p_trip->>'location_count')::integer<0
    OR pg_catalog.jsonb_array_length(p_trip->'readings')>30000
    OR pg_catalog.jsonb_array_length(p_trip->'readings')<>(p_trip->>'motion_count')::integer+(p_trip->>'location_count')::integer
    OR p_trip->>'ended_at' IS NULL THEN
    RAISE EXCEPTION 'Invalid trip payload' USING ERRCODE='22023';
  END IF;
  trip_uuid:=(p_trip->>'id')::uuid;
  token_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_feedback_token,'UTF8')),'hex');
  meta:=COALESCE(NULLIF(p_trip->'metadata','null'::jsonb),'{}'::jsonb)||pg_catalog.jsonb_build_object('feedback_token_hash',token_hash);
  INSERT INTO public.trips(id,started_at,ended_at,duration_seconds,motion_count,location_count,readings,metadata)
  VALUES(trip_uuid,(p_trip->>'started_at')::timestamptz,(p_trip->>'ended_at')::timestamptz,
    (p_trip->>'duration_seconds')::double precision,(p_trip->>'motion_count')::integer,(p_trip->>'location_count')::integer,p_trip->'readings',meta)
  ON CONFLICT(id) DO NOTHING;
  -- Short transaction: authenticate before comparing any stored input.
  PERFORM public._live_score_authorize(trip_uuid,p_feedback_token);
  SELECT * INTO t FROM public.trips WHERE id=trip_uuid FOR UPDATE;
  IF t.started_at IS DISTINCT FROM (p_trip->>'started_at')::timestamptz
    OR t.ended_at IS DISTINCT FROM (p_trip->>'ended_at')::timestamptz
    OR t.duration_seconds IS DISTINCT FROM (p_trip->>'duration_seconds')::double precision
    OR t.motion_count IS DISTINCT FROM (p_trip->>'motion_count')::integer
    OR t.location_count IS DISTINCT FROM (p_trip->>'location_count')::integer
    OR t.readings IS DISTINCT FROM p_trip->'readings' OR t.metadata IS DISTINCT FROM meta THEN
    RAISE EXCEPTION 'Trip identity conflicts with persisted input' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.trip_scores(trip_id,policy_version,score_status,baseline_weights,quality_details)
  VALUES(trip_uuid,'experimental-ride-smoothness/1.0.0','provisional','{"A":0.35,"J":0.40,"R":0.25}',
    pg_catalog.jsonb_build_object('input_fingerprint',p_input_fingerprint,'processing',pg_catalog.jsonb_build_object('state','pending','attempts',0)))
  ON CONFLICT(trip_id,policy_version) DO NOTHING;
  IF EXISTS(SELECT 1 FROM public.trip_scores WHERE trip_id=trip_uuid AND policy_version='experimental-ride-smoothness/1.0.0'
    AND quality_details ? 'input_fingerprint' AND quality_details->>'input_fingerprint'<>p_input_fingerprint) THEN
    RAISE EXCEPTION 'Score input identity mismatch' USING ERRCODE='23514';
  END IF;
  RETURN public.live_baseline_get(trip_uuid,p_feedback_token,false);
END $$;

CREATE FUNCTION public.live_baseline_claim(p_trip_id uuid,p_feedback_token text,p_input_fingerprint text,p_lease_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE s public.trip_scores; n integer; proc jsonb; BEGIN
  PERFORM public._live_score_authorize(p_trip_id,p_feedback_token);
  IF p_input_fingerprint IS NULL OR p_input_fingerprint !~ '^[0-9a-f]{64}$' OR p_lease_id IS NULL THEN
    RAISE EXCEPTION 'Invalid processing identity' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.trip_scores(trip_id,policy_version,score_status,quality_details)
  VALUES(p_trip_id,'experimental-ride-smoothness/1.0.0','provisional',pg_catalog.jsonb_build_object('input_fingerprint',p_input_fingerprint,'processing',pg_catalog.jsonb_build_object('state','pending','attempts',0)))
  ON CONFLICT(trip_id,policy_version) DO NOTHING;
  SELECT * INTO s FROM public.trip_scores WHERE trip_id=p_trip_id AND policy_version='experimental-ride-smoothness/1.0.0' FOR UPDATE;
  IF s.score_status='final' OR s.baseline_score IS NOT NULL OR s.quality_details->'processing'->>'state'='unavailable' THEN
    RETURN pg_catalog.jsonb_build_object('claimed',false);
  END IF;
  IF s.quality_details->>'input_fingerprint' IS DISTINCT FROM p_input_fingerprint THEN
    RAISE EXCEPTION 'Score input identity mismatch' USING ERRCODE='23514';
  END IF;
  proc:=COALESCE(s.quality_details->'processing','{}');
  n:=COALESCE((proc->>'attempts')::integer,0);
  IF n>=3 OR (proc->>'state'='processing' AND (proc->>'lease_until')::timestamptz>pg_catalog.now()) THEN
    RETURN pg_catalog.jsonb_build_object('claimed',false);
  END IF;
  UPDATE public.trip_scores SET quality_details=quality_details||pg_catalog.jsonb_build_object('processing',
    pg_catalog.jsonb_build_object('state','processing','attempts',n+1,'lease_id',p_lease_id,'lease_until',pg_catalog.now()+interval '120 seconds'))
  WHERE id=s.id;
  RETURN pg_catalog.jsonb_build_object('claimed',true);
END $$;

CREATE FUNCTION public.live_baseline_finish(p_trip_id uuid,p_feedback_token text,p_input_fingerprint text,p_lease_id uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE s public.trip_scores; state text; k text; v numeric; quality jsonb; BEGIN
  PERFORM public._live_score_authorize(p_trip_id,p_feedback_token);
  SELECT * INTO s FROM public.trip_scores WHERE trip_id=p_trip_id AND policy_version='experimental-ride-smoothness/1.0.0' FOR UPDATE;
  IF NOT FOUND OR s.score_status='final' OR s.quality_details->>'input_fingerprint' IS DISTINCT FROM p_input_fingerprint
    OR s.quality_details->'processing'->>'state' IS DISTINCT FROM 'processing'
    OR s.quality_details->'processing'->>'lease_id' IS DISTINCT FROM p_lease_id::text THEN RETURN false; END IF;
  state:=p_result->>'state';
  IF state IS NULL OR state NOT IN ('ready','unavailable','failed') THEN RAISE EXCEPTION 'Invalid result state' USING ERRCODE='22023'; END IF;
  FOREACH k IN ARRAY ARRAY['baseline_score','acceleration_score','jerk_score','rotation_score'] LOOP
    v:=(p_result->>k)::numeric;
    IF (state='ready' AND v IS NULL) OR (v IS NOT NULL AND (v<0 OR v>100 OR v::text IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'Invalid score bounds' USING ERRCODE='22023';
    END IF;
  END LOOP;
  quality:=COALESCE(p_result->'quality_details','{}'::jsonb)||pg_catalog.jsonb_build_object(
    'input_fingerprint',p_input_fingerprint,'processing',pg_catalog.jsonb_build_object('state',state,
      'attempts',COALESCE((s.quality_details->'processing'->>'attempts')::integer,0),'reason',p_result->>'reason'));
  UPDATE public.trip_scores SET
    baseline_score=CASE WHEN state='ready' THEN (p_result->>'baseline_score')::numeric ELSE NULL END,
    acceleration_score=CASE WHEN state='ready' THEN (p_result->>'acceleration_score')::numeric ELSE NULL END,
    jerk_score=CASE WHEN state='ready' THEN (p_result->>'jerk_score')::numeric ELSE NULL END,
    rotation_score=CASE WHEN state='ready' THEN (p_result->>'rotation_score')::numeric ELSE NULL END,
    baseline_weights='{"A":0.35,"J":0.40,"R":0.25}'::jsonb,score_status='provisional',
    quality_details=quality,context_details=COALESCE(p_result->'audit','{}'::jsonb),computed_at=pg_catalog.now()
  WHERE id=s.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.live_baseline_get(uuid,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.live_baseline_ingest(jsonb,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.live_baseline_claim(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.live_baseline_finish(uuid,text,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.live_baseline_get(uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_baseline_ingest(jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_baseline_claim(uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_baseline_finish(uuid,text,text,uuid,jsonb) TO service_role;
COMMIT;
