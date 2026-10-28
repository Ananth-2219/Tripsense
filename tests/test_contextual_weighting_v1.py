"""Context lookup, normalization, uncertainty and baseline-preservation tests."""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from analysis.contextual_weighting_v1.layer import load_policy,apply_multipliers,contextualize

REPO=Path(__file__).resolve().parents[1]
IDS=('17b5188c-8d2f-4911-a4cd-4f5903c41027','785e2229-ead3-44ca-ba0a-3fe24194d7a9')

class ContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs={}
        for trip_id in IDS:
            base=json.loads((REPO/'analysis/two_trip_scoring/v1'/(trip_id+'.json')).read_text())
            feedback=json.loads((REPO/'analysis'/trip_id/'feedback_latest.json').read_text())
            cls.inputs[trip_id]=(base,feedback)

    def test_multiplier_formula_with_diagnostic_non_neutral_vector(self):
        weights=apply_multipliers({'A':.35,'J':.4,'R':.25},[{'A':1,'J':1,'R':.5}])
        self.assertAlmostEqual(weights['A'],.35/.875)
        self.assertAlmostEqual(weights['J'],.4/.875)
        self.assertAlmostEqual(weights['R'],.125/.875)
        self.assertAlmostEqual(sum(weights.values()),1)

    def test_common_multiplier_cancels_without_improving_score(self):
        base={'A':.35,'J':.4,'R':.25}
        got=apply_multipliers(base,[{'A':.5,'J':.5,'R':.5}])
        self.assertEqual(got,base)

    def test_multiple_factors_combine_before_normalizing(self):
        factors=[{'A':.8,'J':1,'R':1},{'A':1,'J':.9,'R':.7}]
        got=apply_multipliers({'A':.35,'J':.4,'R':.25},factors)
        raw={'A':.35*.8,'J':.4*.9,'R':.25*.7}
        for k in raw:self.assertAlmostEqual(got[k],raw[k]/sum(raw.values()))

    def test_invalid_and_all_zero_factors_fail_without_nan(self):
        for vector in [{'A':-1,'J':1,'R':1},{'A':True,'J':1,'R':1},
                       {'A':float('inf'),'J':1,'R':1},{'A':0,'J':0,'R':0},{'A':1,'J':1}]:
            with self.assertRaises(ValueError):apply_multipliers({'A':.35,'J':.4,'R':.25},[vector])

    def test_deployed_policy_explicitly_covers_all_answer_values(self):
        policy=load_policy()
        self.assertEqual(len(policy['rules']),7)
        base,feedback=self.inputs[IDS[0]]
        for rule in policy['rules']:
            for answer,spec in rule['answers'].items():
                rows=deepcopy(feedback);rows[0][rule['field']]=answer
                r=contextualize(base,rows)
                item=next(e for e in r['audit'] if e['rule_id']==rule['id'])
                self.assertEqual(item['answer'],answer)
                self.assertEqual(item['status'],'supported')
                self.assertEqual(item['multipliers'],spec['multipliers'])
                self.assertTrue(item['rationale'])

    def test_actual_trips_baseline_components_weights_unchanged(self):
        for base,feedback in self.inputs.values():
            result=contextualize(base,feedback)
            self.assertEqual(result['components'],base['components'])
            self.assertEqual(result['baseline_score'],base['baseline_score'])
            self.assertEqual(result['baseline_weights'],base['baseline_weights'])
            self.assertEqual(result['adjusted_weights'],base['baseline_weights'])
            self.assertEqual(result['context_score'],base['baseline_score'])
            self.assertTrue(all(w>=0 for w in result['adjusted_weights'].values()))
            self.assertAlmostEqual(sum(result['adjusted_weights'].values()),1)

    def test_missing_questionnaire_and_fields_use_explicit_neutral_fallback(self):
        base,feedback=self.inputs[IDS[0]]
        partial=deepcopy(feedback);partial[0].pop('phone_placement')
        for rows in [None,[],partial]:
            result=contextualize(base,rows)
            self.assertEqual(result['context_score'],base['baseline_score'])
            self.assertTrue(result['confidence']['fallback_fields'])
            self.assertTrue(any(e['status']=='missing' for e in result['audit']))

    def test_unsupported_values_use_neutral_without_assuming_an_answer(self):
        base,feedback=self.inputs[IDS[0]]
        for value in ['roof',False,[],{},123]:
            rows=deepcopy(feedback);rows[0]['phone_placement']=value
            result=contextualize(base,rows)
            item=result['audit'][0]
            self.assertEqual(item['status'],'unsupported')
            self.assertEqual(item['answer'],value)
            self.assertEqual(item['multipliers'],{'A':1,'J':1,'R':1})
            self.assertEqual(result['context_score'],base['baseline_score'])

    def test_duplicate_and_mismatched_feedback_rejected(self):
        base,feedback=self.inputs[IDS[0]]
        rows=deepcopy(feedback);rows[0]['trip_id']=IDS[1]
        for invalid in [feedback+feedback,rows]:
            with self.assertRaises(ValueError):contextualize(base,invalid)

    def test_allowlist_excludes_bus_and_every_other_trip(self):
        self.assertEqual(set(load_policy()['allowed_trip_ids']),set(IDS))
        base,feedback=deepcopy(self.inputs[IDS[0]])
        base['trip_id']='a7838041-bb7d-4e85-9fb8-6eb35017bf71'
        with self.assertRaises(ValueError):contextualize(base,feedback)

    def test_no_mutation_and_identical_input_is_deterministic(self):
        for inputs in self.inputs.values():
            original=deepcopy(inputs)
            first=contextualize(*inputs);second=contextualize(*inputs)
            self.assertEqual(inputs,original)
            self.assertEqual(json.dumps(first,sort_keys=True),json.dumps(second,sort_keys=True))

    def test_each_condition_has_isolated_and_leave_one_out_sensitivity(self):
        result=contextualize(*self.inputs[IDS[0]])
        self.assertEqual(len(result['condition_sensitivity']),7)
        for row in result['condition_sensitivity']:
            self.assertEqual(row['isolated_delta'],0)
            self.assertEqual(row['leave_one_out_delta'],0)
            self.assertEqual(row['weight_delta'],{'A':0,'J':0,'R':0})

    def test_subjective_smoothness_and_near_miss_never_reward_or_penalize(self):
        base,feedback=deepcopy(self.inputs[IDS[0]])
        original=contextualize(base,feedback)
        feedback[0]['perceived_smoothness']='very_smooth'
        feedback[0]['unusual_event']='near_miss'
        self.assertEqual(contextualize(base,feedback)['context_score'],original['context_score'])

    def test_uncertain_placement_is_not_reported_as_mounted(self):
        for trip_id,(base,feedback) in self.inputs.items():
            confidence=contextualize(base,feedback)['confidence']
            self.assertEqual(confidence['phone_placement'],feedback[0]['phone_placement'])
            self.assertFalse(confidence['secure_mount_verified'])
            self.assertIsNone(confidence['numerical_confidence_multiplier'])

if __name__=='__main__':unittest.main()
