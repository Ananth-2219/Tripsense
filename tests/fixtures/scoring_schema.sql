-- Local-test fixture matching the verified live schema; never apply as a migration.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.trips(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),started_at timestamptz NOT NULL,
 ended_at timestamptz,duration_seconds double precision,motion_count integer DEFAULT 0,location_count integer DEFAULT 0,
 readings jsonb,metadata jsonb,created_at timestamptz DEFAULT now());
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
GRANT INSERT,SELECT ON public.trips TO anon;
CREATE POLICY "Allow trip uploads" ON public.trips FOR INSERT TO anon WITH CHECK(true);
CREATE TABLE public.trip_scores(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
 feedback_id uuid,policy_version text NOT NULL DEFAULT 'experimental_v3',baseline_score numeric,contextual_sensor_score numeric,final_score numeric,
 acceleration_score numeric,jerk_score numeric,rotation_score numeric,baseline_weights jsonb NOT NULL DEFAULT '{"A":0.35,"J":0.40,"R":0.25}',
 contextual_weights jsonb,experience_score numeric,incident_penalty numeric DEFAULT 0,score_status text NOT NULL DEFAULT 'provisional',
 quality_details jsonb NOT NULL DEFAULT '{}',context_details jsonb NOT NULL DEFAULT '{}',computed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(trip_id,policy_version),CHECK(score_status IN ('provisional','final')),
 CHECK((baseline_score IS NULL OR baseline_score BETWEEN 0 AND 100) AND (contextual_sensor_score IS NULL OR contextual_sensor_score BETWEEN 0 AND 100) AND (final_score IS NULL OR final_score BETWEEN 0 AND 100)));
ALTER TABLE public.trip_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_scores FROM PUBLIC,anon,authenticated;
