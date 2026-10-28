"""Experimental scoring invariants; no fixture is presented as trip data."""
from copy import deepcopy
import json
import math
from pathlib import Path
import unittest

from analysis.ride_smoothness_v1.scoring import (
    load_policy, normalize_component, normalize_weights, weighted_score, score_trip)

REPO=Path(__file__).resolve().parents[1]
IDS=('17b5188c-8d2f-4911-a4cd-4f5903c41027','785e2229-ead3-44ca-ba0a-3fe24194d7a9')

class SmoothnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs={}
        for trip_id in IDS:
            folder=REPO/'analysis'/trip_id
            summary=next(iter(json.loads((folder/'results.json').read_text())['trips'].values()))
            feedback=json.loads((folder/'feedback_latest.json').read_text())
            cls.inputs[trip_id]=(summary,feedback)

    def score(self,trip_id=IDS[0]):
        return score_trip(trip_id,*self.inputs[trip_id])

    def test_normalization_anchor_values_and_monotonicity(self):
        self.assertEqual(normalize_component(0,7),100)
        self.assertEqual(normalize_component(7,7),50)
        self.assertAlmostEqual(normalize_component(14,7),100/3)
        self.assertGreater(normalize_component(1,7),normalize_component(2,7))

    def test_normalization_and_scores_are_bounded(self):
        for x in [0,1e-12,1,1e4,1e300]:
            self.assertTrue(0<=normalize_component(x,7)<=100)
        for trip_id in IDS:
            r=self.score(trip_id)
            self.assertTrue(all(0<=v<=100 for v in r['components'].values()))
            self.assertTrue(0<=r['baseline_score']<=100)
            self.assertTrue(0<=r['context_score']<=100)

    def test_invalid_measurements_and_references_rejected(self):
        for x in [-1,float('nan'),float('inf'),True,None]:
            with self.assertRaises(ValueError): normalize_component(x,7)
        for ref in [0,-1,float('nan'),float('inf'),True]:
            with self.assertRaises(ValueError): normalize_component(1,ref)

    def test_weight_sum_and_independent_arithmetic(self):
        weights={'A':.35,'J':.40,'R':.25}
        self.assertEqual(weighted_score({'A':10,'J':50,'R':90},weights),46)
        for trip_id in IDS:
            r=self.score(trip_id)
            self.assertAlmostEqual(sum(r['baseline_weights'].values()),1)
            self.assertAlmostEqual(sum(r['context_weights'].values()),1)
            expected=.35*r['components']['A']+.40*r['components']['J']+.25*r['components']['R']
            self.assertAlmostEqual(r['baseline_score'],expected)
            self.assertAlmostEqual(sum(r['baseline_contributions'].values()),r['baseline_score'])

    def test_invalid_weights_rejected(self):
        for w in [{'A':1},{'A':-1,'J':1,'R':1},{'A':0,'J':0,'R':0},
                  {'A':float('nan'),'J':.4,'R':.25},{'A':True,'J':.4,'R':.25}]:
            with self.assertRaises(ValueError): normalize_weights(w)
        with self.assertRaises(ValueError): weighted_score({'A':1,'J':2,'R':3},{'A':1,'J':1,'R':1})

    def test_reproducibility(self):
        self.assertEqual(json.dumps(self.score(),sort_keys=True),json.dumps(self.score(),sort_keys=True))

    def test_shared_frozen_references(self):
        p=load_policy()
        self.assertEqual(p['baseline_weights'],{'A':.35,'J':.40,'R':.25})
        for trip_id in IDS:
            r=self.score(trip_id)
            for key,spec in p['normalization']['components'].items():
                mean=self.inputs[trip_id][0][spec['summary_field']]['mean']
                self.assertEqual(r['components'][key],100/(1+mean/spec['reference']))
            self.assertEqual(r['references'],self.score(IDS[0])['references'])

    def test_missing_incomplete_duplicate_and_mismatched_feedback(self):
        summary,feedback=self.inputs[IDS[0]]
        incomplete=deepcopy(feedback);incomplete[0].pop('phone_movement')
        mismatched=deepcopy(feedback);mismatched[0]['trip_id']=IDS[1]
        invalid=deepcopy(feedback);invalid[0]['road_condition']='unknown_category'
        for records in [[],None,incomplete,mismatched,invalid,feedback+feedback]:
            r=score_trip(IDS[0],summary,records)
            self.assertIsNone(r['context_score'])
            self.assertIsNone(r['context_weights'])
            self.assertTrue(r['context_unavailable_reason'])
            self.assertEqual(r['baseline_score'],self.score()['baseline_score'])

    def test_no_source_mutation(self):
        for trip_id in IDS:
            summary,feedback=self.inputs[trip_id]
            before=deepcopy((summary,feedback))
            score_trip(trip_id,summary,feedback)
            self.assertEqual((summary,feedback),before)

    def test_bus_and_all_other_unlisted_ids_rejected(self):
        policy=load_policy()
        self.assertEqual(set(policy['allowed_trip_ids']),set(IDS))
        for trip_id in ['a7838041-bb7d-4e85-9fb8-6eb35017bf71','00000000-0000-0000-0000-000000000001']:
            with self.assertRaises(ValueError): score_trip(trip_id,*self.inputs[IDS[0]])

    def test_source_identity_mismatch_rejected(self):
        with self.assertRaises(ValueError): score_trip(IDS[0],*self.inputs[IDS[1]])

    def test_context_rule_traceability_and_no_unsupported_adjustment(self):
        policy=load_policy()
        rule_ids={r['id'] for r in policy['context']['dimensions']}
        for trip_id in IDS:
            r=self.score(trip_id)
            self.assertEqual({e['rule_id'] for e in r['context_audit']},rule_ids)
            self.assertTrue(all(e['factors']=={'A':1,'J':1,'R':1} for e in r['context_audit']))
            self.assertTrue(all(not e['changed_weights'] for e in r['context_audit']))
            self.assertEqual(r['context_weights'],r['baseline_weights'])
            self.assertEqual(r['context_score'],r['baseline_score'])
            self.assertEqual(r['absolute_context_difference'],0)

    def test_all_documented_answer_categories_are_traceable(self):
        summary,feedback=self.inputs[IDS[0]]
        for rule in load_policy()['context']['dimensions']:
            for answer in rule['answers']:
                records=deepcopy(feedback);records[0][rule['fields'][0]]=answer
                r=score_trip(IDS[0],summary,records)
                entry=next(e for e in r['context_audit'] if e['rule_id']==rule['id'])
                self.assertEqual(entry['answer'],answer)
                self.assertEqual(r['context_score'],r['baseline_score'])

    def test_sensitivity_to_diagnostic_weight_changes(self):
        # Diagnostic perturbations test the engine; they are not feedback policy.
        components={'A':10,'J':50,'R':90}
        weights={'A':.35,'J':.4,'R':.25}
        altered=normalize_weights({'A':weights['A']*.5,'J':weights['J'],'R':weights['R']})
        self.assertGreater(weighted_score(components,altered),weighted_score(components,weights))
        for trip_id in IDS:
            r=self.score(trip_id)
            for key in ['A','J','R']:
                changed=normalize_weights({k:v*(1.1 if k==key else 1) for k,v in r['baseline_weights'].items()})
                self.assertNotAlmostEqual(weighted_score(r['components'],changed),r['baseline_score'],places=8)
            self.assertEqual(r,self.score(trip_id))

    def test_reliability_does_not_modify_numerical_score(self):
        summary,feedback=deepcopy(self.inputs[IDS[0]])
        r=score_trip(IDS[0],summary,feedback)
        summary['stored_duration']=summary['stored_duration']*2
        changed=score_trip(IDS[0],summary,feedback)
        self.assertEqual(r['components'],changed['components'])
        self.assertEqual(r['baseline_score'],changed['baseline_score'])
        self.assertEqual(r['context_score'],changed['context_score'])
        self.assertNotEqual(r['reliability'],changed['reliability'])

if __name__=='__main__': unittest.main()
