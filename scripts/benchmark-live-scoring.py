"""Measure the real service against the ephemeral local PostgreSQL RPC adapter.

Called by benchmark-live-scoring.mjs; never use real Supabase credentials here.
HTTP upload timing uses Starlette's in-process client, excluding phone/network RTT.
"""
import hashlib,json,os,sys,time
from pathlib import Path
from statistics import median
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from fastapi.testclient import TestClient
from scoring_service.app import create_app
from scoring_service.repository import from_environment

if not os.environ.get('SCORING_SUPABASE_URL','').startswith('http://127.0.0.1:'):
    raise SystemExit('Benchmark requires the isolated local test database')
results=[]
token='a'*64
with TestClient(create_app(from_environment())) as client:
    for label,trip_id in [('short','785e2229-ead3-44ca-ba0a-3fe24194d7a9'),('long','17b5188c-8d2f-4911-a4cd-4f5903c41027')]:
        raw=json.loads((ROOT/'analysis'/trip_id/(trip_id+'.json')).read_text())
        data=dict(id=trip_id,startedAt=raw['started_at'],endedAt=raw['ended_at'],durationSeconds=raw['duration_seconds'],
                  motionCount=raw['motion_count'],locationCount=raw['location_count'],readings=raw['readings'],metadata=None)
        samples=[]
        for repetition in range(3):
            # Fresh local identities measure durable insertion instead of cache hits.
            from uuid import uuid4
            data['id']=str(uuid4());body=json.dumps(data,separators=(',',':')).encode()
            headers={'Authorization':'Bearer '+token,'X-Trip-Input-Fingerprint':hashlib.sha256(body).hexdigest(),'Content-Type':'application/json'}
            start=time.perf_counter();response=client.post('/api/trips',content=body,headers=headers)
            accepted=time.perf_counter();response.raise_for_status()
            for _ in range(400):
                status=client.get('/api/trips/'+data['id']+'/score',headers=headers);status.raise_for_status()
                if status.json()['score']['state'] not in ['pending','processing']:break
                time.sleep(.05)
            assert status.json()['score']['state']=='ready',status.json()
            for _ in range(100):
                if data['id'] in client.app.state.worker.timings:break
                time.sleep(.01)
            samples.append(dict(upload_acceptance_ms=(accepted-start)*1000,**client.app.state.worker.timings[data['id']]))
        results.append(dict(fixture=label,source_trip_id=trip_id,duration_seconds=raw['duration_seconds'],readings=len(raw['readings']),
            payload_bytes=len(body),baseline_score=status.json()['score']['baselineScore'],samples=samples,
            median_ms={k:median(s[k] for s in samples) for k in samples[0]}))
print(json.dumps(dict(environment='Python 3.12 / FastAPI TestClient / real HTTP RPC / ephemeral PGlite on this Windows desktop',
    limitations='Upload includes request validation and durable trip/placeholder persistence; excludes phone uplink and live Supabase latency. Score persistence includes local HTTP RPC and serialization. No maps/reports are generated during scoring.',results=results),indent=2))
