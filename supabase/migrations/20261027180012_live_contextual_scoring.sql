-- Phase3: manual review/application only. Existing tables/RLS/grants/data unchanged.
-- Baseline policy_version stays on the same row; contextual provenance is nested.
BEGIN;
DO $$ BEGIN
  IF to_regprocedure('public.live_baseline_get(uuid,text,boolean)') IS NULL
    OR to_regclass('public.trip_feedback') IS NULL THEN
    RAISE EXCEPTION 'Verify the existing Phase2 schema and RPCs first';
  END IF;
END $$;

CREATE FUNCTION public._live_contextual_fingerprint(s public.trip_scores,f public.trip_feedback)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' SET timezone='UTC'
AS $$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
  'score_id',s.id,'trip_id',s.trip_id,'policy_version',s.policy_version,
  'baseline_score',s.baseline_score,'acceleration_score',s.acceleration_score,
  'jerk_score',s.jerk_score,'rotation_score',s.rotation_score,'baseline_weights',s.baseline_weights,
  'quality_details',s.quality_details,'baseline_audit',s.context_details-'contextual_v3',
  'accepted_feedback',pg_catalog.to_jsonb(f))::text,'UTF8')),'hex') $$;
REVOKE ALL ON FUNCTION public._live_contextual_fingerprint(public.trip_scores,public.trip_feedback) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.live_contextual_get(p_trip_id uuid,p_feedback_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$ DECLARE s public.trip_scores; f public.trip_feedback; BEGIN
  PERFORM public._live_score_authorize(p_trip_id,p_feedback_token);
  SELECT * INTO s FROM public.trip_scores WHERE trip_id=p_trip_id AND policy_version='experimental-ride-smoothness/1.0.0';
  SELECT * INTO f FROM public.trip_feedback WHERE trip_id=p_trip_id;
  RETURN pg_catalog.jsonb_build_object('trip',pg_catalog.jsonb_build_object('id',p_trip_id),
    'score',CASE WHEN s.id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(s) END,
    'feedback',CASE WHEN f.id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(f)-'comments' END,
    'source_fingerprint',CASE WHEN s.id IS NULL OR f.id IS NULL THEN NULL ELSE public._live_contextual_fingerprint(s,f) END);
END $$;

CREATE FUNCTION public.live_contextual_finish(p_trip_id uuid,p_feedback_token text,p_feedback_id uuid,p_source_fingerprint text,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ DECLARE s public.trip_scores; f public.trip_feedback; k text; v numeric; weights jsonb; total numeric:=0; BEGIN
  PERFORM public._live_score_authorize(p_trip_id,p_feedback_token);
  -- No external calls or calculation under these short row locks.
  SELECT * INTO s FROM public.trip_scores WHERE trip_id=p_trip_id AND policy_version='experimental-ride-smoothness/1.0.0' FOR UPDATE;
  IF s.id IS NULL OR s.baseline_score IS NULL THEN RAISE EXCEPTION 'Baseline is not ready' USING ERRCODE='23514'; END IF;
  SELECT * INTO f FROM public.trip_feedback WHERE id=p_feedback_id AND trip_id=p_trip_id FOR SHARE;
  IF f.id IS NULL THEN RAISE EXCEPTION 'Accepted feedback association does not match' USING ERRCODE='23514'; END IF;
  IF p_source_fingerprint IS DISTINCT FROM public._live_contextual_fingerprint(s,f) THEN
    RAISE EXCEPTION 'Contextual source identity changed' USING ERRCODE='23514';
  END IF;
  IF s.score_status='final' THEN
    IF s.feedback_id IS DISTINCT FROM p_feedback_id OR s.context_details->'contextual_v3'->>'policy_version' IS DISTINCT FROM 'experimental-contextual-scoring/3.0.0'
      OR s.context_details->'contextual_v3'->>'source_fingerprint' IS DISTINCT FROM p_source_fingerprint THEN
      RAISE EXCEPTION 'Final score identity does not match' USING ERRCODE='23514';
    END IF;
    RETURN public.live_baseline_get(p_trip_id,p_feedback_token,false);
  END IF;
  IF pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'policy_version' IS DISTINCT FROM 'experimental-contextual-scoring/3.0.0'
    OR p_result->>'policy_sha256' IS DISTINCT FROM 'e4d40140853da4b7731b3d8ee1e6ce89469ae4a9c2fd4613a9cfb3a9801d2483' THEN
    RAISE EXCEPTION 'Invalid contextual policy' USING ERRCODE='22023';
  END IF;
  FOREACH k IN ARRAY ARRAY['contextual_sensor_score','experience_score','incident_penalty','final_feedback_inclusive_score'] LOOP
    v:=(p_result->>k)::numeric;
    IF v IS NULL OR v<0 OR v>(CASE WHEN k='incident_penalty' THEN 1.5 ELSE 100 END) OR v::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Invalid contextual score bounds' USING ERRCODE='22023';
    END IF;
  END LOOP;
  weights:=p_result->'contextual_weights';
  IF pg_catalog.jsonb_typeof(weights) IS DISTINCT FROM 'object' OR
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(weights))<>3 OR NOT weights ?& ARRAY['A','J','R'] THEN
    RAISE EXCEPTION 'Invalid contextual weights' USING ERRCODE='22023';
  END IF;
  FOREACH k IN ARRAY ARRAY['A','J','R'] LOOP
    v:=(weights->>k)::numeric;
    IF v IS NULL OR v<0 OR v>1 OR v::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid contextual weight' USING ERRCODE='22023'; END IF;
    total:=total+v;
  END LOOP;
  IF pg_catalog.abs(total-1)>0.000000000001 THEN RAISE EXCEPTION 'Invalid contextual weight sum' USING ERRCODE='22023'; END IF;
  UPDATE public.trip_scores SET feedback_id=p_feedback_id,
    contextual_sensor_score=(p_result->>'contextual_sensor_score')::numeric,contextual_weights=weights,
    experience_score=(p_result->>'experience_score')::numeric,incident_penalty=(p_result->>'incident_penalty')::numeric,
    final_score=(p_result->>'final_feedback_inclusive_score')::numeric,score_status='final',
    context_details=context_details||pg_catalog.jsonb_build_object('contextual_v3',p_result||pg_catalog.jsonb_build_object(
      'source_fingerprint',p_source_fingerprint,'feedback_id',p_feedback_id,'baseline_computed_at',s.computed_at)),
    computed_at=pg_catalog.now()
  WHERE id=s.id;
  RETURN public.live_baseline_get(p_trip_id,p_feedback_token,false);
END $$;

REVOKE ALL ON FUNCTION public.live_contextual_get(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.live_contextual_finish(uuid,text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.live_contextual_get(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_contextual_finish(uuid,text,uuid,text,jsonb) TO service_role;
COMMIT;
