"""One-time historical snapshot; never overwrite earlier analysis artifacts."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'analysis/live_baseline_phase2'
OUT.mkdir(parents=True,exist_ok=True)
snapshot=OUT/'historical_hashes.json'
if snapshot.exists():raise SystemExit('Existing snapshot retained; do not replace it')
files=[p for r in ['analysis','trip_visualization','.trip_maps'] for p in (ROOT/r).rglob('*')
       if p.is_file() and OUT not in p.parents and '__pycache__' not in p.parts and '.trip_maps/live-scoring' not in p.as_posix()]
snapshot.write_text(json.dumps({p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2,sort_keys=True)+'\n')
before=OUT/'before_application'
for r in ['src','docs','tests']:
    for p in (ROOT/r).rglob('*'):
        if p.is_file():
            target=before/p.relative_to(ROOT);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(p.read_bytes())
for name in ['package.json','package-lock.json','vite.config.js','README.md','.gitignore']:
    (before/name).write_bytes((ROOT/name).read_bytes())
print('Historical files fingerprinted:',len(files))
