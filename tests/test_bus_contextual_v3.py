"""Bus scope extension must reuse scoring mathematics without changing policies."""
from copy import deepcopy
import json,math
from pathlib import Path
import unittest
from application_preservation import verify_application_snapshot
from analysis.bus_contextual_v3.evaluate import (BUS,baseline_for_bus,bus_condition_impacts,
    score_bus,scope_audit,verify_preservation)
from analysis.contextual_scoring_v3.scoring import load_policy,score_trip

REPO=Path(__file__).resolve().parents[1]

class BusContextualV3Tests(unittest.TestCase):
    def inputs(self):
        base=baseline_for_bus()
        rows=json.loads((REPO/'analysis'/BUS/'feedback_latest.json').read_text())
        return base,rows

    def test_frozen_v1_baseline_formula_and_references(self):
        base=baseline_for_bus()
        refs={'A':7.035623639735144,'J':45.052178163487305,'R':66.92398673121619}
        self.assertEqual(base['references'],refs)
        self.assertEqual(base['baseline_weights'],{'A':.35,'J':.4,'R':.25})
        for k in refs:self.assertEqual(base['components'][k],100/(1+base['mean_inputs'][k]/refs[k]))
        self.assertAlmostEqual(base['baseline_score'],sum(base['components'][k]*base['baseline_weights'][k] for k in refs))

    def test_real_bus_identity_and_original_policy_scope_unchanged(self):
        base,rows=self.inputs();before=deepcopy(load_policy())
        r=score_bus(base,rows)
        self.assertEqual(r['trip_id'],BUS)
        self.assertEqual(load_policy(),before)
        self.assertNotIn(BUS,before['allowed_trip_ids'])
        with self.assertRaises(ValueError):score_trip(base,rows)
        self.assertTrue(scope_audit()['original_v3_calculation_code_reused'])

    def test_bus_only_adapter_rejects_other_identity(self):
        base,rows=self.inputs();base['trip_id']=load_policy()['allowed_trip_ids'][0]
        with self.assertRaises(ValueError):score_bus(base,rows)

    def test_all_bus_factors_match_finalized_coefficients(self):
        base,rows=self.inputs();r=score_bus(base,rows)
        raw={'A':.98*.95*1.05,'J':.95*.9*.95*1.05*.9,'R':.9}
        for k in raw:self.assertAlmostEqual(r['raw_multipliers'][k],raw[k])
        total=sum(base['baseline_weights'][k]*raw[k] for k in raw)
        for k in raw:self.assertAlmostEqual(r['contextual_weights'][k],base['baseline_weights'][k]*raw[k]/total)
        self.assertAlmostEqual(sum(r['contextual_weights'].values()),1)

    def test_unsure_experience_neutral_and_pothole_no_direct_penalty(self):
        r=score_bus(*self.inputs())
        self.assertEqual(r['experience_score'],r['contextual_sensor_score'])
        self.assertEqual(r['incident_penalty'],0)
        self.assertAlmostEqual(r['final_feedback_inclusive_score'],r['contextual_sensor_score'])
        self.assertIn('perceived_smoothness',r['fallback_fields'])

    def test_seven_questionnaire_effects_including_neutral_placement(self):
        base,rows=self.inputs();r=score_bus(base,rows);effects=bus_condition_impacts(base,rows)
        self.assertEqual(len(effects),7)
        self.assertAlmostEqual(sum(x['sequential_final_delta'] for x in effects),r['final_feedback_inclusive_score']-base['baseline_score'])
        placement=next(x for x in effects if x['field']=='phone_placement')
        self.assertAlmostEqual(placement['leave_one_out_final_delta'],0)

    def test_observed_coverage_and_gap_not_imputed_or_scored(self):
        base=baseline_for_bus();observed=base['recording_reliability']['observed_motion_seconds']
        self.assertAlmostEqual(observed,931.829)
        self.assertAlmostEqual(base['recording_quality']['initial_motion_missing_seconds'],117.872,places=5)
        self.assertLess(observed,base['recording_reliability']['duration_seconds'])
        self.assertAlmostEqual(base['recording_reliability']['motion_coverage_percent'],88.76125793592203)
        expected=100/(1+base['mean_inputs']['A']/base['references']['A'])
        self.assertEqual(base['components']['A'],expected)

    def test_reported_pothole_is_not_automatically_a_harsh_ride_penalty(self):
        base,rows=self.inputs();with_pothole=score_bus(base,rows)
        rows[0]['unusual_event']='none';without=score_bus(base,rows)
        self.assertEqual(with_pothole['components'],without['components'])
        self.assertEqual(with_pothole['incident_penalty'],without['incident_penalty'])
        self.assertNotEqual(with_pothole['contextual_sensor_score'],without['contextual_sensor_score'])

    def test_feedback_association_duplicates_and_determinism(self):
        base,rows=self.inputs();before=deepcopy((base,rows))
        self.assertEqual(score_bus(base,rows),score_bus(base,rows))
        self.assertEqual((base,rows),before)
        with self.assertRaises(ValueError):score_bus(base,rows+rows)
        rows[0]['trip_id']='wrong'
        with self.assertRaises(ValueError):score_bus(base,rows)

    def test_prior_artifacts_and_two_previous_trip_scores_preserved(self):
        self.assertGreater(verify_application_snapshot(REPO/'analysis/bus_scoring/v3/preserved_hashes.json'),600)

if __name__=='__main__':unittest.main()
