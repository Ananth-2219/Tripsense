"""One-time immutable Phase3 preservation checkpoint; never reinitialize."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'analysis/live_contextual_phase3'
OUT.mkdir(parents=True,exist_ok=True)
manifest=OUT/'historical_hashes.json'
if manifest.exists():raise SystemExit('Existing checkpoint retained; do not replace it')
files=[p for name in ['analysis','trip_visualization','.trip_maps'] for p in (ROOT/name).rglob('*')
       if p.is_file() and OUT not in p.parents and '__pycache__' not in p.parts and '.trip_maps/live-contextual' not in p.as_posix()]
manifest.write_text(json.dumps({p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2,sort_keys=True)+'\n')
for name in ['src','docs','tests','scripts','scoring_service','trip_scoring','supabase/migrations']:
    for p in (ROOT/name).rglob('*'):
        if p.is_file() and '__pycache__' not in p.parts:
            target=OUT/'before_application'/p.relative_to(ROOT)
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(p.read_bytes())
for name in ['package.json','package-lock.json','vite.config.js','README.md','.gitignore','requirements-scoring.txt','requirements-scoring.lock.txt','requirements-scoring-test.lock.txt']:
    target=OUT/'before_application'/name;target.write_bytes((ROOT/name).read_bytes())
print('Preserved historical file count:',len(files))
