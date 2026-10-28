"""Acceptance tests for the user-specified experimental v3 policy."""
from copy import deepcopy
import json
import math
from pathlib import Path
import unittest
from application_preservation import verify_application_snapshot

from analysis.contextual_scoring_v3.scoring import (apply_weights, condition_impacts,
    load_policy, score_trip, verify_preservation)

REPO=Path(__file__).resolve().parents[1]
IDS=['17b5188c-8d2f-4911-a4cd-4f5903c41027','785e2229-ead3-44ca-ba0a-3fe24194d7a9']
WEIGHTS={'A':.35,'J':.40,'R':.25}

class ContextualScoringV3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baselines={i:json.loads((REPO/'analysis/two_trip_scoring/v1'/(i+'.json')).read_text()) for i in IDS}

    def inputs(self,index=0):
        base=deepcopy(self.baselines[IDS[index]])
        return base,[deepcopy(base['feedback'])]

    def test_policy_exact_allowlist_and_experimental_status(self):
        p=load_policy()
        self.assertEqual(p['allowed_trip_ids'],IDS)
        self.assertTrue(p['experimental'])
        self.assertEqual(p['baseline_weights'],WEIGHTS)
        self.assertEqual(p['multiplier_clip'],[.7,1.3])
        self.assertIn('not derived from validated research',p['coefficient_origin'])

    def test_actual_learner_arithmetic_from_specification(self):
        base,rows=self.inputs()
        r=score_trip(base,rows)
        raw={'A':.95*.98*.95*1.05,'J':.95*.95*.9*.95*1.05,'R':.7*.9}
        clipped={k:max(.7,min(1.3,v)) for k,v in raw.items()}
        denominator=sum(WEIGHTS[k]*clipped[k] for k in WEIGHTS)
        expected_weights={k:WEIGHTS[k]*clipped[k]/denominator for k in WEIGHTS}
        for k in WEIGHTS:self.assertAlmostEqual(r['contextual_weights'][k],expected_weights[k])
        sensor=sum(expected_weights[k]*base['components'][k] for k in WEIGHTS)
        self.assertAlmostEqual(r['contextual_sensor_score'],sensor)
        self.assertEqual(r['experience_score'],65)
        self.assertEqual(r['incident_penalty'],1.5)
        self.assertAlmostEqual(r['final_feedback_inclusive_score'],.9*sensor+.1*65-1.5)

    def test_actual_third_arithmetic_from_specification(self):
        base,rows=self.inputs(1);r=score_trip(base,rows)
        factors={'A':.98*1.05,'J':.95*1.05*1.05,'R':.9}
        total=sum(WEIGHTS[k]*factors[k] for k in WEIGHTS)
        expected=sum(base['components'][k]*WEIGHTS[k]*factors[k]/total for k in WEIGHTS)
        self.assertAlmostEqual(r['contextual_sensor_score'],expected)
        self.assertEqual(r['experience_score'],95)
        self.assertEqual(r['incident_penalty'],0)
        self.assertAlmostEqual(r['final_feedback_inclusive_score'],.9*expected+9.5)

    def test_saved_baseline_components_references_and_contributions_unchanged(self):
        for i in range(2):
            base,rows=self.inputs(i);r=score_trip(base,rows)
            for key in ['baseline_score','components','baseline_weights','baseline_contributions','references']:
                self.assertEqual(r[key],base[key])

    def test_missing_questionnaire_and_fields_are_neutral_and_flagged(self):
        base,_=self.inputs()
        for rows in [None,[],[{'trip_id':base['trip_id']}]]:
            r=score_trip(base,rows)
            self.assertAlmostEqual(r['contextual_sensor_score'],base['baseline_score'])
            self.assertAlmostEqual(r['final_feedback_inclusive_score'],base['baseline_score'])
            self.assertEqual(len(r['fallback_fields']),7)
            self.assertEqual(r['experience_score'],r['contextual_sensor_score'])

    def test_unknown_answers_neutral_for_each_field(self):
        base,_=self.inputs()
        for field in list(load_policy()['multiplier_rules'])+['perceived_smoothness']:
            r=score_trip(base,[{'trip_id':base['trip_id'],field:'not_in_policy'}])
            self.assertIn(field,r['fallback_fields'])
            self.assertAlmostEqual(r['final_feedback_inclusive_score'],base['baseline_score'])

    def test_single_choice_arrays_and_invalid_values_are_not_guessed(self):
        base,_=self.inputs()
        for value in [['pocket'],{},True,8]:
            r=score_trip(base,[{'trip_id':base['trip_id'],'phone_placement':value}])
            self.assertIn('phone_placement',r['fallback_fields'])
            self.assertAlmostEqual(r['contextual_sensor_score'],base['baseline_score'])

    def test_multiselect_deduplicates_supported_factors_and_incident_penalty(self):
        base,_=self.inputs()
        row=dict(trip_id=base['trip_id'],reported_maneuvers=['turning','braking','braking'],
                 unusual_event=['near_miss','pothole','near_miss'])
        r=score_trip(base,[row])
        self.assertAlmostEqual(r['raw_multipliers']['J'],1.05*.9)
        self.assertAlmostEqual(r['raw_multipliers']['R'],1.08)
        self.assertEqual(r['incident_penalty'],1.5)
        self.assertIn('duplicate_answer_ignored',r['sensor_audit'][-1]['flags'])

    def test_multiselect_order_and_separator_forms_have_identical_scores(self):
        base,_=self.inputs()
        scores=[]
        for answer in ['braking,turning',' turning ; braking ','turning|braking',['turning','braking']]:
            r=score_trip(base,[dict(trip_id=base['trip_id'],reported_maneuvers=answer)])
            scores.append(r['final_feedback_inclusive_score'])
        self.assertEqual(len(set(scores)),1)

    def test_none_conflict_is_flagged_and_explicit_selection_wins(self):
        base,_=self.inputs()
        r=score_trip(base,[dict(trip_id=base['trip_id'],unusual_event=['none','near_miss'])])
        self.assertEqual(r['incident_penalty'],1.5)
        self.assertIn('none_conflicts_with_selection',r['sensor_audit'][-1]['flags'])

    def test_mixed_known_unknown_multiselect_applies_only_known(self):
        base,_=self.inputs()
        r=score_trip(base,[dict(trip_id=base['trip_id'],reported_maneuvers=['braking','unknown',4])])
        self.assertEqual(r['raw_multipliers'],{'A':1.05,'J':1.05,'R':1})
        self.assertIn('reported_maneuvers',r['fallback_fields'])

    def test_significant_movement_spelling_is_canonicalized(self):
        base,_=self.inputs()
        r=score_trip(base,[dict(trip_id=base['trip_id'],phone_movement=' significant movement ')])
        self.assertEqual(r['raw_multipliers'],{'A':.9,'J':.85,'R':.75})
        self.assertNotIn('phone_movement',r['fallback_fields'])

    def test_clip_both_bounds_then_normalize(self):
        r=apply_weights(WEIGHTS,[{'A':.1,'J':2,'R':1}])
        self.assertEqual(r['clipped_multipliers'],{'A':.7,'J':1.3,'R':1})
        self.assertAlmostEqual(sum(r['contextual_weights'].values()),1)
        self.assertTrue(all(v>=0 for v in r['contextual_weights'].values()))

    def test_clipping_occurs_after_full_product_not_per_factor(self):
        r=apply_weights(WEIGHTS,[{'A':.5,'J':1,'R':1},{'A':2,'J':1,'R':1}])
        self.assertEqual(r['clipped_multipliers'],{'A':1,'J':1,'R':1})
        self.assertEqual(r['contextual_weights'],WEIGHTS)

    def test_invalid_numeric_inputs_rejected(self):
        for value in [-1,float('nan'),float('inf'),True]:
            with self.assertRaises(ValueError):apply_weights(WEIGHTS,[{'A':value,'J':1,'R':1}])
        base,rows=self.inputs();base['components']['A']=101
        with self.assertRaises(ValueError):score_trip(base,rows)

    def test_final_score_bounds_include_negative_incident_case(self):
        base,rows=self.inputs()
        for value in [0,100]:
            base['components']={k:value for k in WEIGHTS}
            base['baseline_score']=value
            base['baseline_contributions']={k:value*w for k,w in WEIGHTS.items()}
            rows[0]['perceived_smoothness']='unsure'
            r=score_trip(base,rows)
            self.assertTrue(0<=r['final_feedback_inclusive_score']<=100)
            self.assertEqual(r['final_feedback_inclusive_score'],max(0,value-1.5))
        rows[0]['unusual_event']='none'
        self.assertEqual(score_trip(base,rows)['final_feedback_inclusive_score'],100)

    def test_changed_baseline_weights_references_or_score_are_rejected(self):
        for key in ['baseline_weights','references','baseline_score']:
            base,rows=self.inputs()
            if isinstance(base[key],dict):base[key]['A']+=.001
            else:base[key]+=.001
            with self.assertRaises(ValueError):score_trip(base,rows)

    def test_unsure_experience_uses_context_not_baseline(self):
        base,rows=self.inputs();rows[0]['perceived_smoothness']='unsure'
        r=score_trip(base,rows)
        self.assertEqual(r['experience_score'],r['contextual_sensor_score'])

    def test_experience_mappings_are_exact_and_do_not_change_sensor_score(self):
        base,rows=self.inputs()
        scores=[]
        for answer,value in [('very_smooth',95),('smooth',85),('mixed',65),('rough',45),('very_rough',25)]:
            rows[0]['perceived_smoothness']=answer;r=score_trip(base,rows)
            self.assertEqual(r['experience_score'],value)
            scores.append(r['contextual_sensor_score'])
        self.assertEqual(len(set(scores)),1)

    def test_counterfactual_smoothness_and_incident_have_expected_impacts(self):
        base,rows=self.inputs()
        rows[0]['perceived_smoothness']='very_smooth';a=score_trip(base,rows)
        rows[0]['perceived_smoothness']='very_rough';b=score_trip(base,rows)
        self.assertAlmostEqual(a['final_feedback_inclusive_score']-b['final_feedback_inclusive_score'],7)
        rows[0]['unusual_event']='none';c=score_trip(base,rows)
        self.assertAlmostEqual(c['final_feedback_inclusive_score']-b['final_feedback_inclusive_score'],1.5)
        self.assertEqual(a['components'],c['components'])

    def test_counterfactual_road_and_placement_change_weights_with_fixed_sensors(self):
        base,rows=self.inputs();a=score_trip(base,rows)
        rows[0]['road_condition']='rough';rows[0]['phone_placement']='other';b=score_trip(base,rows)
        self.assertEqual(a['components'],b['components'])
        self.assertNotEqual(a['contextual_weights'],b['contextual_weights'])
        self.assertNotEqual(a['contextual_sensor_score'],b['contextual_sensor_score'])

    def test_duplicate_wrong_association_and_bus_are_rejected(self):
        base,rows=self.inputs()
        with self.assertRaises(ValueError):score_trip(base,rows+rows)
        rows[0]['trip_id']=IDS[1]
        with self.assertRaises(ValueError):score_trip(base,rows)
        base['trip_id']='a7838041-bb7d-4e85-9fb8-6eb35017bf71'
        with self.assertRaises(ValueError):score_trip(base,[])

    def test_determinism_no_mutation_and_comments_have_no_effect(self):
        base,rows=self.inputs();before=deepcopy((base,rows))
        a=score_trip(base,rows);b=score_trip(base,rows)
        self.assertEqual(a,b);self.assertEqual((base,rows),before)
        rows[0]['comments']='new unsupported speed assertion'
        self.assertEqual(a['final_feedback_inclusive_score'],score_trip(base,rows)['final_feedback_inclusive_score'])

    def test_sequential_impacts_telescope_and_conditions_are_complete(self):
        base,rows=self.inputs();r=score_trip(base,rows);impact=condition_impacts(base,rows)
        self.assertEqual(len(impact),7)
        self.assertAlmostEqual(sum(x['sequential_final_delta'] for x in impact),r['final_feedback_inclusive_score']-base['baseline_score'])
        incident=next(x for x in impact if x['field']=='unusual_event')
        self.assertAlmostEqual(incident['leave_one_out_final_delta'],-1.5)

    def test_all_preexisting_artifacts_are_preserved(self):
        self.assertGreater(verify_application_snapshot(REPO/'analysis/two_trip_scoring/v3/preserved_hashes.json'),500)

if __name__=='__main__':unittest.main()
