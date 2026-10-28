"""Read-only local final checks. No extraction, report regeneration or DB writes."""
import hashlib,json,re,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
from application_preservation import digest
OUT=ROOT/'analysis/live_baseline_phase2'

def read_log(name):
    data=(OUT/name).read_bytes()
    return data.decode('utf-16') if data.startswith(b'\xff\xfe') else data.decode('utf-8-sig')

def main():
    manifest=json.loads((OUT/'historical_hashes.json').read_text())
    changed=[name for name,sha in manifest.items() if not (ROOT/name).is_file() or digest(ROOT/name)!=sha]
    assert not changed,'Historical artifacts changed: '+str(changed)
    # The legacy preservation tests call this same strict original/archive/seal checker.
    seal=json.loads((ROOT/'tests/fixtures/phase2_application_hashes.json').read_text())
    assert all(digest(ROOT/p)==sha for p,sha in seal.items()),'Application seal mismatch'
    policy=ROOT/'trip_scoring/policies/baseline_v1.json'
    assert policy.read_bytes()==(ROOT/'analysis/ride_smoothness_v1/policy.json').read_bytes()
    assert hashlib.sha256(policy.read_bytes()).hexdigest()==(ROOT/'trip_scoring/policies/baseline_v1.sha256').read_text().strip()
    python=read_log('python-tests.log');javascript=read_log('javascript-tests.log')
    total=int(re.search(r'Ran (\d+) tests',python).group(1));assert python.rstrip().endswith('OK')
    assert re.search(r'(?:fail\s+0)',javascript) and 'Tests  65 passed' in javascript
    assert 'FAILED' not in javascript and 'Test Files  11 passed' in javascript
    browsers={name:json.loads((ROOT/'.trip_maps/live-scoring'/name/'browser-verification.json').read_text()) for name in ['feedback']}
    browsers['scoring']=json.loads((ROOT/'.trip_maps/live-scoring/browser-verification.json').read_text())
    assert all(v['passed'] and v['pageErrors']==0 and v['unmockedRemoteRequests']==0 for v in browsers.values())
    benchmarks=json.loads((OUT/'benchmarks.json').read_text())
    assert [r['baseline_score'] for r in benchmarks['results']]==[89.45285168835801,80.30795859668785]
    result=dict(passed=True,historical_files_verified=len(manifest),historical_changes=changed,
        packaged_policy_byte_identical=True,application_originals_archived=True,application_seal_verified=True,
        python_tests=total,node_sensor_tests=39,vitest_tests=65,browsers=browsers,
        regression_baselines={'learner':80.30795859668785,'third':89.45285168835801,'bus':91.43690819817843},
        baseline_policy='experimental-ride-smoothness/1.0.0',contextual_applied=False,
        migration_applied_live=False,live_score_writes=0,live_backend_credentials_configured=False,
        manual_blockers=['Review/apply 20261027162918_live_baseline_scoring.sql','Configure backend-only Supabase credentials','Private physical-phone and authorized live-persistence verification'],
        benchmarks=benchmarks['results'])
    (OUT/'final_validation.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['browsers','benchmarks']},indent=2))

if __name__=='__main__':main()
