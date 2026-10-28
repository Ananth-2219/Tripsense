"""Frozen baseline v1 helpers, promoted from the validated offline implementation."""
import hashlib,json,math
from pathlib import Path

POLICY_PATH=Path(__file__).parent/'policies/baseline_v1.json'

def load_policy():
    data=POLICY_PATH.read_bytes()
    if hashlib.sha256(data).hexdigest()!=POLICY_PATH.with_suffix('.sha256').read_text().strip():
        raise ValueError('Frozen baseline policy changed')
    return json.loads(data)

def number(value,*,positive=False):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0 or (positive and value==0):
        raise ValueError('Expected finite nonnegative value')
    return float(value)

def normalize_component(value,reference):
    return 100/(1+number(value)/number(reference,positive=True))

def normalize_weights(weights):
    values={k:number(weights[k]) for k in ['A','J','R']}
    total=math.fsum(values.values())
    if total<=0:raise ValueError('Positive weight sum required')
    return {k:v/total for k,v in values.items()}

def weighted_score(components,weights):
    return math.fsum(components[k]*weights[k] for k in sorted(components))

def score_baseline(features):
    policy=load_policy();specs=policy['normalization']['components']
    weights=normalize_weights(policy['baseline_weights'])
    complete=all(features[spec['summary_field']].get('n',0)>0 for spec in specs.values())
    if not complete or features['quality']['observed_motion_seconds']<=0:
        return dict(state='unavailable',policy_version=policy['version'],baseline_score=None,
            acceleration_score=None,jerk_score=None,rotation_score=None,baseline_weights=weights,
            reason='Not enough valid acceleration, jerk and rotation observations to calculate a baseline score.')
    components={k:normalize_component(features[spec['summary_field']]['mean'],spec['reference']) for k,spec in specs.items()}
    return dict(state='ready',policy_version=policy['version'],baseline_score=weighted_score(components,weights),
        acceleration_score=components['A'],jerk_score=components['J'],rotation_score=components['R'],
        baseline_weights=weights,reason=None)
