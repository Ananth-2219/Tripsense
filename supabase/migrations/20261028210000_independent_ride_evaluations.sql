-- Phase 4: Independent ride evaluation and score agreement.
-- Apply manually as database owner (e.g. Supabase SQL Editor).
-- Never modifies or deletes existing trips, scores, or feedback.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.trips') IS NULL THEN
    RAISE EXCEPTION 'Verify the existing trips table schema first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.score_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL UNIQUE REFERENCES public.trips(id) ON DELETE CASCADE,
  comfort_rating integer,
  comfort_rating_submitted_at timestamptz,
  comfort_rating_skipped boolean NOT NULL DEFAULT false,
  score_agreement text,
  score_agreement_submitted_at timestamptz,
  score_agreement_skipped boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

-- Ensure all columns exist if the table was previously created with a partial schema
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='comfort_rating') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN comfort_rating integer;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='comfort_rating_submitted_at') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN comfort_rating_submitted_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='comfort_rating_skipped') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN comfort_rating_skipped boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='score_agreement') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN score_agreement text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='score_agreement_submitted_at') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN score_agreement_submitted_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='score_agreement_skipped') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN score_agreement_skipped boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='created_at') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN created_at timestamptz NOT NULL DEFAULT pg_catalog.now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='score_evaluations' AND column_name='updated_at') THEN
    ALTER TABLE public.score_evaluations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT pg_catalog.now();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_evaluations_comfort_bounds') THEN
    ALTER TABLE public.score_evaluations
      ADD CONSTRAINT score_evaluations_comfort_bounds
      CHECK (comfort_rating IS NULL OR (comfort_rating >= 0 AND comfort_rating <= 100)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'score_evaluations_agreement_valid') THEN
    ALTER TABLE public.score_evaluations
      ADD CONSTRAINT score_evaluations_agreement_valid
      CHECK (score_agreement IS NULL OR score_agreement IN ('yes', 'partially', 'no', 'not_sure')) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.score_evaluations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.score_evaluations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.live_evaluation_get(p_trip_id uuid, p_feedback_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  e public.score_evaluations;
BEGIN
  PERFORM public._live_score_authorize(p_trip_id, p_feedback_token);
  SELECT * INTO e FROM public.score_evaluations WHERE trip_id = p_trip_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'trip_id', e.trip_id,
    'comfort_rating', e.comfort_rating,
    'comfort_rating_submitted_at', e.comfort_rating_submitted_at,
    'comfort_rating_skipped', e.comfort_rating_skipped,
    'score_agreement', e.score_agreement,
    'score_agreement_submitted_at', e.score_agreement_submitted_at,
    'score_agreement_skipped', e.score_agreement_skipped,
    'created_at', e.created_at,
    'updated_at', e.updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.live_evaluation_submit(
  p_trip_id uuid,
  p_feedback_token text,
  p_comfort_rating integer DEFAULT NULL,
  p_comfort_skipped boolean DEFAULT NULL,
  p_score_agreement text DEFAULT NULL,
  p_score_agreement_skipped boolean DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  e public.score_evaluations;
  new_comfort integer;
  new_comfort_submitted_at timestamptz;
  new_comfort_skipped boolean;
  new_agreement text;
  new_agreement_submitted_at timestamptz;
  new_agreement_skipped boolean;
BEGIN
  PERFORM public._live_score_authorize(p_trip_id, p_feedback_token);

  IF p_comfort_rating IS NOT NULL AND (p_comfort_rating < 0 OR p_comfort_rating > 100) THEN
    RAISE EXCEPTION 'Comfort rating must be between 0 and 100' USING ERRCODE='22023';
  END IF;
  IF p_score_agreement IS NOT NULL AND p_score_agreement NOT IN ('yes', 'partially', 'no', 'not_sure') THEN
    RAISE EXCEPTION 'Invalid score agreement value' USING ERRCODE='22023';
  END IF;

  SELECT * INTO e FROM public.score_evaluations WHERE trip_id = p_trip_id FOR UPDATE;

  IF FOUND THEN
    -- Once submitted, never silently overwrite an existing independent rating.
    IF e.comfort_rating IS NOT NULL THEN
      new_comfort := e.comfort_rating;
      new_comfort_submitted_at := e.comfort_rating_submitted_at;
      new_comfort_skipped := false;
    ELSIF p_comfort_rating IS NOT NULL THEN
      new_comfort := p_comfort_rating;
      new_comfort_submitted_at := pg_catalog.now();
      new_comfort_skipped := false;
    ELSIF p_comfort_skipped IS TRUE AND NOT e.comfort_rating_skipped THEN
      new_comfort := NULL;
      new_comfort_submitted_at := pg_catalog.now();
      new_comfort_skipped := true;
    ELSE
      new_comfort := e.comfort_rating;
      new_comfort_submitted_at := e.comfort_rating_submitted_at;
      new_comfort_skipped := e.comfort_rating_skipped;
    END IF;

    -- Score agreement: once set, do not overwrite with conflicting choice
    IF e.score_agreement IS NOT NULL THEN
      new_agreement := e.score_agreement;
      new_agreement_submitted_at := e.score_agreement_submitted_at;
      new_agreement_skipped := false;
    ELSIF p_score_agreement IS NOT NULL THEN
      new_agreement := p_score_agreement;
      new_agreement_submitted_at := pg_catalog.now();
      new_agreement_skipped := false;
    ELSIF p_score_agreement_skipped IS TRUE AND NOT e.score_agreement_skipped THEN
      new_agreement := NULL;
      new_agreement_submitted_at := pg_catalog.now();
      new_agreement_skipped := true;
    ELSE
      new_agreement := e.score_agreement;
      new_agreement_submitted_at := e.score_agreement_submitted_at;
      new_agreement_skipped := e.score_agreement_skipped;
    END IF;

    UPDATE public.score_evaluations SET
      comfort_rating = new_comfort,
      comfort_rating_submitted_at = new_comfort_submitted_at,
      comfort_rating_skipped = new_comfort_skipped,
      score_agreement = new_agreement,
      score_agreement_submitted_at = new_agreement_submitted_at,
      score_agreement_skipped = new_agreement_skipped,
      updated_at = pg_catalog.now()
    WHERE trip_id = p_trip_id;
  ELSE
    IF p_comfort_rating IS NOT NULL THEN
      new_comfort := p_comfort_rating;
      new_comfort_submitted_at := pg_catalog.now();
      new_comfort_skipped := false;
    ELSIF p_comfort_skipped IS TRUE THEN
      new_comfort := NULL;
      new_comfort_submitted_at := pg_catalog.now();
      new_comfort_skipped := true;
    ELSE
      new_comfort := NULL;
      new_comfort_submitted_at := NULL;
      new_comfort_skipped := false;
    END IF;

    IF p_score_agreement IS NOT NULL THEN
      new_agreement := p_score_agreement;
      new_agreement_submitted_at := pg_catalog.now();
      new_agreement_skipped := false;
    ELSIF p_score_agreement_skipped IS TRUE THEN
      new_agreement := NULL;
      new_agreement_submitted_at := pg_catalog.now();
      new_agreement_skipped := true;
    ELSE
      new_agreement := NULL;
      new_agreement_submitted_at := NULL;
      new_agreement_skipped := false;
    END IF;

    INSERT INTO public.score_evaluations (
      trip_id,
      comfort_rating,
      comfort_rating_submitted_at,
      comfort_rating_skipped,
      score_agreement,
      score_agreement_submitted_at,
      score_agreement_skipped,
      created_at,
      updated_at
    ) VALUES (
      p_trip_id,
      new_comfort,
      new_comfort_submitted_at,
      new_comfort_skipped,
      new_agreement,
      new_agreement_submitted_at,
      new_agreement_skipped,
      pg_catalog.now(),
      pg_catalog.now()
    );
  END IF;

  RETURN public.live_evaluation_get(p_trip_id, p_feedback_token);
END $$;

REVOKE ALL ON FUNCTION public.live_evaluation_get(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_evaluation_submit(uuid, text, integer, boolean, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_evaluation_get(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_evaluation_submit(uuid, text, integer, boolean, text, boolean) TO service_role;

COMMIT;
