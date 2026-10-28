"""Metadata-only finalization benchmark against isolated local PostgreSQL RPCs."""
import json,os,sys,time
from pathlib import Path
from statistics import median
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from fastapi.testclient import TestClient
from scoring_service.app import create_app
from scoring_service.repository import from_environment
if not os.environ.get('SCORING_SUPABASE_URL','').startswith('http://127.0.0.1:'):
    raise SystemExit('Only the isolated local benchmark database is allowed')
cases=json.loads(sys.stdin.read());measurements=[];token='a'*64
with TestClient(create_app(from_environment())) as client:
    for case in cases:
        started=time.perf_counter()
        response=client.post('/api/trips/'+case['id']+'/score/finalize',headers={'Authorization':'Bearer '+token,'X-Trip-Input-Fingerprint':case['fingerprint']})
        elapsed=(time.perf_counter()-started)*1000
        response.raise_for_status();score=response.json()['score']
        assert score['status']=='final' and score['contextual']['finalScore']==case['expected_final']
        measurements.append(dict(fixture=case['fixture'],source_trip_id=case['source_trip_id'],
            baseline_score=score['baselineScore'],contextual_sensor_score=score['contextual']['sensorScore'],
            final_score=score['contextual']['finalScore'],http_round_trip_ms=elapsed,**client.app.state.finalizer.timings[case['id']]))
summaries=[]
for label in ['learner','third','bus']:
    samples=[row for row in measurements if row['fixture']==label]
    summaries.append(dict(fixture=label,baseline_score=samples[0]['baseline_score'],contextual_sensor_score=samples[0]['contextual_sensor_score'],
        final_score=samples[0]['final_score'],median_ms={k:median(s[k] for s in samples) for k in samples[0] if k.endswith('_ms')},samples=samples))
print(json.dumps(dict(environment='Windows / Python 3.12 / real FastAPI TestClient + HTTP RPCs + ephemeral PGlite',
    limitations='Three fresh local finalizations per fixture; no raw readings or feature extraction. End-to-end is service retrieval/calculation/update; HTTP timing also includes local ASGI dispatch. Excludes actual phone and live Supabase network latency.',results=summaries),indent=2))
