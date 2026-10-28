"""Frozen full-precision v3 regressions and explicit live execution admission."""
from copy import deepcopy
import hashlib,json,math
from pathlib import Path
from uuid import uuid4
import unittest
from trip_scoring.contextual import score_trip,score_saved_baseline,load_policy,apply_weights

ROOT=Path(__file__).resolve().parents[1]
IDS=['17b5188c-8d2f-4911-a4cd-4f5903c41027','785e2229-ead3-44ca-ba0a-3fe24194d7a9','a7838041-bb7d-4e85-9fb8-6eb35017bf71']
def golden(index=0):
    path=ROOT/'analysis'/('bus_scoring/v3/bus_result.json' if index==2 else 'two_trip_scoring/v3/'+IDS[index]+'.json')
    g=json.loads(path.read_text())
    base={k:deepcopy(g[k]) for k in ['trip_id','baseline_score','baseline_weights','baseline_contributions','references','components']}
    base['policy_version']=g['baseline_policy_version']
    return g,base,deepcopy(g['feedback'])

class LiveContextualTests(unittest.TestCase):
    def test_three_historical_full_precision_scores_weights_and_audits(self):
        for i in range(3):
            g,base,feedback=golden(i);before=deepcopy((base,feedback));actual=score_trip(base,[feedback])
            for key in ['baseline_score','contextual_sensor_score','final_feedback_inclusive_score','experience_score','incident_penalty','contextual_weights','raw_multipliers','clipped_multipliers','sensor_audit','experience_audit']:
                self.assertEqual(actual[key],g[key],key)
            self.assertEqual((base,feedback),before)
    def test_saved_database_scores_use_full_precision_without_extraction(self):
        for i in range(3):
            g,base,feedback=golden(i)
            row=dict(trip_id=base['trip_id'],policy_version=base['policy_version'],baseline_score=base['baseline_score'],baseline_weights=base['baseline_weights'],
                acceleration_score=base['components']['A'],jerk_score=base['components']['J'],rotation_score=base['components']['R'])
            actual=score_saved_baseline(row,feedback)
            self.assertEqual(actual['final_feedback_inclusive_score'],g['final_feedback_inclusive_score'])
    def test_live_recording_uses_explicit_new_scope_without_changing_old_policy(self):
        _,base,feedback=golden();new_id=str(uuid4());base['trip_id']=feedback['trip_id']=new_id
        self.assertEqual(score_trip(base,[feedback])['trip_id'],new_id)
        self.assertEqual(load_policy()['allowed_trip_ids'],IDS[:2])
        self.assertEqual((ROOT/'trip_scoring/policies/contextual_v3.json').read_bytes(),(ROOT/'analysis/contextual_scoring_v3/policy.json').read_bytes())
    def test_association_invalid_components_and_missing_baseline_rejected(self):
        _,base,feedback=golden();feedback['trip_id']=str(uuid4())
        with self.assertRaises(ValueError):score_trip(base,[feedback])
        for value in [float('nan'),float('inf'),True,-1,101]:
            broken=deepcopy(base);broken['components']['A']=value
            with self.assertRaises(ValueError):score_trip(broken,[])
    def test_all_supported_conditions_missing_unknown_and_existing_ui_values(self):
        _,base,_=golden();policy=load_policy()
        for field,rules in policy['multiplier_rules'].items():
            for answer,vector in rules.items():
                result=score_trip(base,[dict(trip_id=base['trip_id'],**{field:answer})])
                audit=next(a for a in result['sensor_audit'] if a['field']==field)
                self.assertEqual(audit['multipliers'],vector)
        for rows in [None,[],[dict(trip_id=base['trip_id'],perceived_smoothness='unsure',phone_placement='not_supported')]]:
            self.assertAlmostEqual(score_trip(base,rows)['final_feedback_inclusive_score'],base['baseline_score'])
        # Frozen policy expressly forbids invented semantic aliases.
        result=score_trip(base,[dict(trip_id=base['trip_id'],perceived_smoothness='mostly_smooth',phone_movement='frequent_movement')])
        self.assertIn('perceived_smoothness',result['fallback_fields']);self.assertIn('phone_movement',result['fallback_fields'])
        self.assertEqual(result['experience_audit']['source'],'neutral_contextual_sensor_score')
    def test_multiselect_deduplication_clipping_normalization_bounds_and_determinism(self):
        _,base,_=golden();feedback=dict(trip_id=base['trip_id'],reported_maneuvers=['braking','turning','braking'],unusual_event='near_miss|pothole|near_miss')
        result=score_trip(base,[feedback]);self.assertEqual(result,score_trip(base,[feedback]));self.assertEqual(result['incident_penalty'],1.5)
        combined=apply_weights(base['baseline_weights'],[dict(A=.1,J=8,R=1)])
        self.assertEqual(combined['clipped_multipliers'],dict(A=.7,J=1.3,R=1))
        self.assertAlmostEqual(math.fsum(combined['contextual_weights'].values()),1)
        for component in [0,100]:
            b=deepcopy(base);b['components']=dict.fromkeys('AJR',component);b['baseline_contributions']={k:b['baseline_weights'][k]*component for k in 'AJR'};b['baseline_score']=component
            self.assertTrue(0<=score_trip(b,[feedback])['final_feedback_inclusive_score']<=100)

if __name__=='__main__':unittest.main()
