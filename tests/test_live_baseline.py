from copy import deepcopy
import json
from pathlib import Path
import unittest
from trip_scoring.extraction import extract_features
from trip_scoring.baseline import score_baseline,load_policy

ROOT=Path(__file__).resolve().parents[1]
IDS=['17b5188c-8d2f-4911-a4cd-4f5903c41027','785e2229-ead3-44ca-ba0a-3fe24194d7a9','a7838041-bb7d-4e85-9fb8-6eb35017bf71']
class LiveBaselineTests(unittest.TestCase):
    def test_exact_historical_feature_and_baseline_parity(self):
        expected=[80.30795859668785,89.45285168835801,91.43690819817843]
        for trip_id,score in zip(IDS,expected):
            folder=ROOT/'analysis'/trip_id
            raw=json.loads((folder/(trip_id+'.json')).read_text())
            prior=next(iter(json.loads((folder/'results.json').read_text())['trips'].values()))
            before=deepcopy(raw)
            f=extract_features(raw);result=score_baseline(f)
            for key in ['acceleration','absjerk','gyro']:
                for stat in ['mean','std','p95','maximum','n']:
                    self.assertAlmostEqual(f[key][stat],prior[key][stat],places=11)
            self.assertAlmostEqual(f['quality']['observed_motion_seconds'],prior['observed_support'],places=9)
            self.assertAlmostEqual(result['baseline_score'],score,places=11)
            self.assertEqual(raw,before)
    def fixture(self,readings):
        return dict(started_at='1970-01-01T00:00:01Z',ended_at='1970-01-01T00:00:02Z',duration_seconds=1,readings=readings)
    def test_empty_and_single_motion_are_unavailable_not_perfect(self):
        for rows in [[],[dict(type='motion',timestamp=100,x=0,y=0,z=0,rotationAlpha=0,rotationBeta=0,rotationGamma=0)]]:
            result=score_baseline(extract_features(self.fixture(rows)))
            self.assertEqual(result['state'],'unavailable');self.assertIsNone(result['baseline_score'])
    def test_missing_axes_not_zero_filled_or_bridged(self):
        rows=[dict(type='motion',timestamp=1000+i*100,x=1,y=0,z=0,rotationAlpha=1,rotationBeta=0,rotationGamma=0) for i in range(3)]
        rows[1]['x']=None
        f=extract_features(self.fixture(rows))
        self.assertEqual(f['acceleration']['n'],2)
        self.assertEqual(f['absjerk'],{})
        self.assertEqual(f['quality']['observed_motion_seconds'],0)
        self.assertEqual(score_baseline(f)['state'],'unavailable')
    def test_motion_gap_and_order_match_validated_method(self):
        row=dict(type='motion',x=1,y=0,z=0,rotationAlpha=1,rotationBeta=0,rotationGamma=0)
        rows=[dict(row,timestamp=t) for t in [1000,1100,5000,5100]]
        f=extract_features(self.fixture(list(reversed(rows))))
        self.assertAlmostEqual(f['quality']['observed_motion_seconds'],.2)
        self.assertEqual(len(f['quality']['motion_gaps']),1)
    def test_missing_gps_does_not_fabricate_positions_or_change_score(self):
        rows=[dict(type='motion',timestamp=1000+i*100,x=1,y=0,z=0,rotationAlpha=1,rotationBeta=0,rotationGamma=0) for i in range(3)]
        f=extract_features(self.fixture(rows))
        self.assertIn('No GPS readings recorded.',f['quality']['warnings'])
        self.assertEqual(score_baseline(f)['state'],'ready')
    def test_frozen_policy_identifier_and_no_context_scores(self):
        p=load_policy()
        self.assertEqual(p['version'],'experimental-ride-smoothness/1.0.0')
        self.assertEqual(p['baseline_weights'],{'A':.35,'J':.4,'R':.25})
if __name__=='__main__':unittest.main()
