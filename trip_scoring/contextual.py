"""Frozen experimental v3 mathematics; tracked and import-safe.

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


def finite(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:
        raise ValueError('Expected finite nonnegative numeric value')
    return value


def apply_weights(weights,vectors):
    if set(weights)!=set(KEYS) or not math.isclose(math.fsum(finite(v) for v in weights.values()),1,abs_tol=1e-12):
        raise ValueError('Exactly A/J/R weights summing to one required')
    raw=dict.fromkeys(KEYS,1.0)
    for vector in vectors:
        if set(vector)!=set(KEYS):raise ValueError('Exactly A/J/R factors required')
        for k in KEYS:raw[k]=finite(raw[k]*finite(vector[k]))
    # Clip the complete product once, never each factor or a running clipped product.
    clipped={k:max(.70,min(1.30,v)) for k,v in raw.items()}
    weighted={k:weights[k]*clipped[k] for k in KEYS}
    total=math.fsum(weighted.values())
    return dict(raw_multipliers=raw,clipped_multipliers=clipped,
                unnormalized_weights=weighted,normalization_denominator=total,
                contextual_weights={k:v/total for k,v in weighted.items()})


def canonical(value):
    return re.sub(r'[\s-]+','_',value.strip().lower())


def resolve(field,value,answers,multiple=False):
    flags=[]
    missing=value is None or value=='' or (isinstance(value,list) and not value)
    if missing:tokens=[]
    elif multiple and isinstance(value,str):tokens=re.split(r'[,;|]',value)
    elif multiple and isinstance(value,list):tokens=value
    else:tokens=[value]
    selected=[];unsupported=[];seen=set()
    for token in tokens:
        if not isinstance(token,str):unsupported.append(token);continue
        normalized=canonical(token)
        if not normalized:continue
        if normalized in seen:flags.append('duplicate_answer_ignored');continue
        seen.add(normalized)
        if normalized in answers:selected.append(normalized)
        else:unsupported.append(token)
    # An explicitly reported selection takes precedence; this is not inferred occurrence.
    if 'none' in selected and any(x!='none' for x in seen):
        selected.remove('none');flags.append('none_conflicts_with_selection')
    selected.sort()
    if unsupported:flags.append('unsupported_answer_neutral')
    if not selected and not unsupported:flags.append('missing_answer_neutral')
    status='partial_fallback' if selected and unsupported else 'unsupported' if unsupported else 'supported' if selected else 'missing'
    return dict(field=field,answer=deepcopy(value),selected_answers=selected,
                unsupported_answers=deepcopy(unsupported),flags=sorted(set(flags)),status=status)


def score_trip(baseline,feedback_records):
    policy=load_policy()
    trip_id=baseline.get('trip_id')
    UUID(trip_id)  # Live admission is authorized independently of the historical report allowlist.
    weights=baseline['baseline_weights']
    components=baseline['components']
    if weights!=policy['baseline_weights'] or baseline['references']!=policy['references']:
        raise ValueError('Baseline weights/references differ from frozen source')
    if set(components)!=set(KEYS) or any(finite(v)>100 for v in components.values()):
        raise ValueError('A/J/R component scores must be in [0,100]')
    expected=math.fsum(weights[k]*components[k] for k in KEYS)
    if not math.isclose(finite(baseline['baseline_score']),expected,rel_tol=0,abs_tol=1e-12):
        raise ValueError('Saved baseline score is inconsistent with saved components')
    if any(not math.isclose(finite(baseline['baseline_contributions'][k]),weights[k]*components[k],rel_tol=0,abs_tol=1e-12) for k in KEYS):
        raise ValueError('Saved baseline contributions inconsistent')
    if feedback_records is None:feedback_records=[]
    if not isinstance(feedback_records,list) or len(feedback_records)>1:
        raise ValueError('At most one questionnaire is allowed')
    feedback=feedback_records[0] if feedback_records else {}
    if feedback_records and (not isinstance(feedback,dict) or feedback.get('trip_id')!=trip_id):
        raise ValueError('Questionnaire association does not match')
    audits=[];vectors=[]
    # JSON policy is sorted, so explicitly fix the human-readable causal-audit order.
    fields=['phone_placement','phone_movement','road_condition','traffic_condition','reported_maneuvers','unusual_event']
    for field in fields:
        answers=policy['multiplier_rules'][field]
        audit=resolve(field,feedback.get(field),answers,field in policy['combination_rules']['multiselect_fields'])
        vector={k:math.prod(answers[a][k] for a in audit['selected_answers']) for k in KEYS}
        audit['multipliers']=vector
        vectors.append(vector);audits.append(audit)
    combined=apply_weights(weights,vectors)
    adjusted=combined['contextual_weights']
    sensor=math.fsum(adjusted[k]*components[k] for k in KEYS)
    experience=resolve('perceived_smoothness',feedback.get('perceived_smoothness'),policy['experience_mapping'])
    if experience['selected_answers']:
        experience_score=policy['experience_mapping'][experience['selected_answers'][0]]
        experience['source']='perceived_smoothness_mapping'
    else:
        experience_score=sensor
        experience['source']='neutral_contextual_sensor_score'
        if feedback.get('perceived_smoothness')=='unsure':
            experience['status']='neutral_unsure';experience['flags']=['unsure_experience_neutral']
    penalty=math.fsum(policy['incident_penalties'][a] for a in audits[-1]['selected_answers'])
    blended=math.fsum([policy['sensor_fraction']*sensor,policy['experience_fraction']*experience_score])
    unclamped=blended-penalty
    low,high=policy['score_bounds']
    final=max(low,min(high,unclamped))
    return dict(trip_id=trip_id,policy_version=policy['version'],experimental=True,
        coefficient_origin=policy['coefficient_origin'],baseline_policy_version=baseline['policy_version'],
        components=deepcopy(components),references=deepcopy(baseline['references']),
        baseline_weights=deepcopy(weights),baseline_score=baseline['baseline_score'],
        baseline_contributions=deepcopy(baseline['baseline_contributions']),**combined,
        contextual_contributions={k:adjusted[k]*components[k] for k in KEYS},
        contextual_sensor_score=sensor,experience_score=experience_score,
        experience_contribution=policy['experience_fraction']*experience_score,
        sensor_contribution=policy['sensor_fraction']*sensor,incident_penalty=penalty,
        blend_before_penalty=blended,unclamped_final=unclamped,final_feedback_inclusive_score=final,
        sensor_change_from_baseline=sensor-baseline['baseline_score'],
        final_change_from_baseline=final-baseline['baseline_score'],
        experience_blend_change=blended-sensor,clamp_change=final-unclamped,
        sensor_audit=audits,experience_audit=experience,
        fallback_fields=[a['field'] for a in audits+[experience] if a['status']!='supported'],
        feedback=deepcopy(feedback),feedback_record_count=len(feedback_records),
        confidence=dict(status='Limited and uncalibrated; separate from the score',
          secure_mount_verified=False,numerical_confidence_multiplier=None,
          phone_placement=deepcopy(feedback.get('phone_placement')),
          phone_movement=deepcopy(feedback.get('phone_movement')),
          incident_interpretation='Feedback report only; no inferred driver fault or sensor confirmation'))


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
