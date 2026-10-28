"""Explicitly seal authorized new application files; never rewrite old manifests."""
import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
from application_preservation import ALLOWED,digest
path=ROOT/'tests/fixtures/phase2_application_hashes.json'
path.write_text(json.dumps({p:digest(ROOT/p) for p in sorted(ALLOWED) if (ROOT/p).is_file()},indent=2)+'\n')
print('Explicit Phase2 application seal written; original bytes remain archived.')
