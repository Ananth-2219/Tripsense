"""Verify preserved bytes, copied math, completed tests and local contextual results.

Reads local evidence only; never extracts readings or connects to a database.
"""
import ast,copy,hashlib,json,re,sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'analysis/live_contextual_phase3'
sys.path.insert(0,str(ROOT/'tests'))
from application_preservation import digest,verify_application_snapshot

def log(name):
    data=(OUT/name).read_bytes()
    return data.decode('utf-16') if data.startswith(b'\xff\xfe') else data.decode('utf-8-sig')

def functions(path):
    return {n.name:n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef)}

def main():
    manifest=json.loads((OUT/'historical_hashes.json').read_text())
    changed=[name for name,sha in manifest.items() if not (ROOT/name).is_file() or digest(ROOT/name)!=sha]
    assert not changed,'Historical files changed: '+str(changed)
    seal=json.loads((ROOT/'tests/fixtures/phase3_application_hashes.json').read_text())
    assert all((ROOT/p).is_file() and digest(ROOT/p)==sha for p,sha in seal.items()),'Explicit application seal mismatch'
    archive=OUT/'before_application';application_changes=[]
    for original in archive.rglob('*'):
        if not original.is_file():continue
        name=original.relative_to(archive).as_posix();current=ROOT/name
        if not current.is_file() or digest(current)!=digest(original):
            assert name in seal,'Unexpected change to Phase2 application: '+name
            application_changes.append(name)
    new_files=[]
    for folder in ['src','docs','tests','scripts','scoring_service','trip_scoring','supabase/migrations']:
        for path in (ROOT/folder).rglob('*'):
            if path.is_file() and '__pycache__' not in path.parts and not (archive/path.relative_to(ROOT)).exists():new_files.append(path.relative_to(ROOT).as_posix())
    assert all('SCORING_SUPABASE_SERVICE_KEY' not in path.read_text() for path in (ROOT/'src').rglob('*') if path.is_file() and path.suffix in ['.js','.jsx'])
    assert digest(ROOT/'tests/fixtures/phase2_application_hashes.json')==digest(archive/'tests/fixtures/phase2_application_hashes.json')
    for path in ['analysis/two_trip_scoring/v3/preserved_hashes.json','analysis/bus_scoring/v3/preserved_hashes.json']:
        verify_application_snapshot(ROOT/path)
    for filename in ['extraction.py','baseline.py']:
        assert (ROOT/'trip_scoring'/filename).read_bytes()==(archive/'trip_scoring'/filename).read_bytes()
    assert (ROOT/'scoring_service/worker.py').read_bytes()==(archive/'scoring_service/worker.py').read_bytes()
    for name,source in [('baseline_v1','ride_smoothness_v1'),('contextual_v3','contextual_scoring_v3')]:
        package=ROOT/'trip_scoring/policies'/(name+'.json')
        assert package.read_bytes()==(ROOT/'analysis'/source/'policy.json').read_bytes()
        assert digest(package)==package.with_suffix('.sha256').read_text().strip()
    original=functions(ROOT/'analysis/contextual_scoring_v3/scoring.py')
    promoted=functions(ROOT/'trip_scoring/contextual.py')
    for name in ['finite','apply_weights','canonical','resolve','score_trip']:
        before,after=copy.deepcopy(original[name]),copy.deepcopy(promoted[name])
        if name=='score_trip':
            old=[n for n in before.body if isinstance(n,ast.If) and 'allowed_trip_ids' in ast.dump(n.test)]
            new=[n for n in after.body if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='UUID']
            assert len(old)==len(new)==1
            before.body.remove(old[0]);after.body.remove(new[0])
        assert ast.dump(before)==ast.dump(after),'Frozen math changed: '+name
    python=log('python-tests.log');javascript=log('javascript-tests.log')
    assert python.rstrip().endswith('OK')
    python_count=int(re.search(r'Ran (\d+) tests',python).group(1))
    node_count=int(re.search(r'pass\s+(\d+)',javascript).group(1))
    vitest_count=int(re.search(r'Tests\s+(\d+) passed',javascript).group(1))
    assert 'fail 0' in javascript and not re.search(r'Test Files[^\r\n]*failed',javascript)
    assert 'warning' not in log('lint.log').lower() and 'error' not in log('lint.log').lower()
    assert 'files generated' in log('build.log')
    browsers={name:json.loads((ROOT/'.trip_maps/live-contextual'/relative/'browser-verification.json').read_text()) for name,relative in [('scoring',''),('feedback','feedback')]}
    assert all(b['passed'] and b['pageErrors']==0 and b['unmockedRemoteRequests']==0 for b in browsers.values())
    benchmarks=json.loads((OUT/'benchmarks.json').read_text())
    parity=[]
    paths=['analysis/two_trip_scoring/v3/17b5188c-8d2f-4911-a4cd-4f5903c41027.json','analysis/two_trip_scoring/v3/785e2229-ead3-44ca-ba0a-3fe24194d7a9.json','analysis/bus_scoring/v3/bus_result.json']
    for row,path in zip(benchmarks['results'],paths):
        golden=json.loads((ROOT/path).read_text())
        for actual,expected in [('baseline_score','baseline_score'),('contextual_sensor_score','contextual_sensor_score'),('final_score','final_feedback_inclusive_score')]:assert row[actual]==golden[expected]
        parity.append({key:row[key] for key in ['fixture','baseline_score','contextual_sensor_score','final_score']})
    live=json.loads((OUT/'live_schema_verification.json').read_text())
    assert live['baseline_rpc_count']==4 and live['contextual_rpc_count']==0 and live['browser_score_grants']==0
    result=dict(passed=True,verified_at=datetime.now(timezone.utc).isoformat(),historical_files_verified=len(manifest),historical_changes=changed,
        frozen_math_ast_identical_except_documented_admission=True,baseline_extraction_and_worker_unchanged=True,
        policies_byte_identical=True,phase2_seal_unchanged=True,phase3_application_seal_verified=True,
        preexisting_user_change=json.loads((OUT/'preexisting_application_changes.json').read_text()),
        changed_application_files=sorted(application_changes),new_source_files=sorted(new_files),backend_secret_variable_absent_from_frontend=True,
        python_tests=python_count,node_sensor_tests=node_count,vitest_tests=vitest_count,
        lint='passed without warnings',build='passed; existing >500kB bundle advisory',browsers=browsers,
        historical_parity=parity,benchmark_results=benchmarks['results'],
        baseline_policy='experimental-ride-smoothness/1.0.0',contextual_policy='experimental-contextual-scoring/3.0.0',
        row_policy_preserved=True,live_schema_verification=live,live_writes_by_this_task=0,migration_applied_by_this_task=False,
        manual_remaining=['Review/apply 20261027180012_live_contextual_scoring.sql','Restart existing backend with unchanged environment variables','Private authorized live-finalization and physical-phone verification'],
        no_ml=True,no_score_evaluations=True)
    (OUT/'final_validation.json').write_text(json.dumps(result,indent=2)+'\n')
    summary={key:value for key,value in result.items() if key not in ['browsers','benchmark_results','preexisting_user_change']}
    print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
