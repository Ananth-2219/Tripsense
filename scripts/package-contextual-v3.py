"""Promote the frozen pure functions verbatim, with explicit live admission only."""
import ast,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'analysis/contextual_scoring_v3/scoring.py'
target=ROOT/'trip_scoring/contextual.py'
if target.exists():raise SystemExit('Promoted implementation exists; do not regenerate it silently')
text=source.read_text();tree=ast.parse(text)
symbols=['finite','apply_weights','canonical','resolve','score_trip']
pieces=[ast.get_source_segment(text,node) for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in symbols]
body='\n\n\n'.join(pieces)
old="    if trip_id not in policy['allowed_trip_ids']:raise ValueError('Trip is not allowed for v3')"
assert body.count(old)==1
body=body.replace(old,"    UUID(trip_id)  # Live admission is authorized independently of the historical report allowlist.")
header='''"""Frozen experimental v3 mathematics; tracked and import-safe.

Pure math promoted verbatim from analysis/contextual_scoring_v3/scoring.py.
Only the historical two-trip execution admission is replaced with UUID validation.
The original policy, coefficients, normalization and offline entry point are intact.
"""
from copy import deepcopy
import hashlib,json,math,re
from pathlib import Path
from uuid import UUID
from trip_scoring.baseline import load_policy as baseline_policy

KEYS=('A','J','R')
POLICY_PATH=Path(__file__).parent/'policies/contextual_v3.json'

def load_policy():
    data=POLICY_PATH.read_bytes()
    if hashlib.sha256(data).hexdigest()!=POLICY_PATH.with_suffix('.sha256').read_text().strip():
        raise ValueError('Frozen contextual v3 policy changed')
    policy=json.loads(data)
    base_path=POLICY_PATH.with_name('baseline_v1.json')
    if hashlib.sha256(base_path.read_bytes()).hexdigest()!=policy['baseline_policy_sha256']:
        raise ValueError('Frozen baseline policy changed')
    return policy


'''
footer='''


def score_saved_baseline(row,feedback):
    """Adapt trusted DB columns only; no raw extraction or answer-value aliases."""
    policy=baseline_policy()
    if row['policy_version']!=policy['version']:
        raise ValueError('Unexpected baseline policy')
    if not isinstance(feedback,dict) or feedback.get('trip_id')!=row['trip_id']:
        raise ValueError('Accepted feedback association is required')
    components={k:float(row[field]) for k,field in [('A','acceleration_score'),('J','jerk_score'),('R','rotation_score')]}
    baseline=dict(trip_id=row['trip_id'],policy_version=row['policy_version'],baseline_score=float(row['baseline_score']),
        baseline_weights=deepcopy(row['baseline_weights']),components=components,
        baseline_contributions={k:row['baseline_weights'][k]*components[k] for k in KEYS},
        references={k:spec['reference'] for k,spec in policy['normalization']['components'].items()})
    return score_trip(baseline,[feedback])
'''
target.write_text(header+body+footer,encoding='utf-8')
policy=ROOT/'analysis/contextual_scoring_v3/policy.json'
data=policy.read_bytes();dest=ROOT/'trip_scoring/policies/contextual_v3.json';dest.write_bytes(data)
dest.with_suffix('.sha256').write_text(hashlib.sha256(data).hexdigest()+'\n')
manifest=dict(original_implementation_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),policy_sha256=hashlib.sha256(data).hexdigest(),
    original_source='analysis/contextual_scoring_v3/scoring.py',copied_math_symbols=symbols,
    admission_change='Historical allowed_trip_ids remains unchanged in the frozen policy. Live execution admits capability-authorized UUIDs; coefficient math is unchanged.',
    no_semantic_aliases=True)
(ROOT/'trip_scoring/policies/contextual_v3_provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Packaged unchanged v3 policy and mathematical functions; live scope documented separately.')
