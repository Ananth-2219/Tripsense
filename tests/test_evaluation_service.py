import unittest
from fastapi.testclient import TestClient
from scoring_service.app import create_app
from live_service_support import MemoryRepository, ID, TOKEN, payload

class EvaluationServiceTests(unittest.TestCase):
    def setUp(self):
        self.repo = MemoryRepository()
        self.client = TestClient(create_app(self.repo))
        self.headers = {'Authorization': 'Bearer ' + TOKEN}
        # Ingest trip first
        self.client.post('/api/trips', json=payload(), headers=self.headers)

    def tearDown(self):
        self.client.close()

    def test_unauthorized_evaluation_rejected(self):
        # Missing token
        r1 = self.client.get(f'/api/trips/{ID}/evaluation')
        self.assertEqual(r1.status_code, 401)
        r2 = self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': 75})
        self.assertEqual(r2.status_code, 401)

        # Invalid token
        bad = {'Authorization': 'Bearer ' + 'b' * 64}
        r3 = self.client.get(f'/api/trips/{ID}/evaluation', headers=bad)
        self.assertEqual(r3.status_code, 403)
        r4 = self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': 75}, headers=bad)
        self.assertEqual(r4.status_code, 403)

    def test_comfort_rating_saved_and_persisted(self):
        # Save independent comfort rating before score reveal
        r = self.client.post(
            f'/api/trips/{ID}/evaluation',
            json={'comfortRating': 85},
            headers=self.headers
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data['tripId'], ID)
        self.assertEqual(data['evaluation']['comfort_rating'], 85)
        self.assertFalse(data['evaluation']['comfort_rating_skipped'])
        self.assertIsNotNone(data['evaluation']['comfort_rating_submitted_at'])
        self.assertIsNone(data['evaluation']['score_agreement'])

        # GET returns the same saved data
        get_r = self.client.get(f'/api/trips/{ID}/evaluation', headers=self.headers)
        self.assertEqual(get_r.status_code, 200)
        self.assertEqual(get_r.json()['evaluation']['comfort_rating'], 85)

    def test_comfort_rating_cannot_be_overwritten(self):
        # Initial submission
        self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': 90}, headers=self.headers)

        # Subsequent attempt to change to 40 must preserve 90
        r2 = self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': 40}, headers=self.headers)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()['evaluation']['comfort_rating'], 90)

    def test_comfort_rating_skipped(self):
        r = self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortSkipped': True}, headers=self.headers)
        self.assertEqual(r.status_code, 200)
        eval_data = r.json()['evaluation']
        self.assertIsNone(eval_data['comfort_rating'])
        self.assertTrue(eval_data['comfort_rating_skipped'])

    def test_score_agreement_saved_after_score_reveal(self):
        # Rider submits comfort rating first
        self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': 80}, headers=self.headers)

        # Then rider submits score agreement after score reveal
        for choice in ['yes', 'partially', 'no', 'not_sure']:
            repo = MemoryRepository()
            client = TestClient(create_app(repo))
            client.post('/api/trips', json=payload(), headers=self.headers)
            r = client.post(f'/api/trips/{ID}/evaluation', json={'scoreAgreement': choice}, headers=self.headers)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['evaluation']['score_agreement'], choice)
            self.assertFalse(r.json()['evaluation']['score_agreement_skipped'])
            client.close()

    def test_score_agreement_skipped(self):
        r = self.client.post(f'/api/trips/{ID}/evaluation', json={'scoreAgreementSkipped': True}, headers=self.headers)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['evaluation']['score_agreement_skipped'])

    def test_invalid_evaluation_payloads_rejected(self):
        # Out of bounds comfort rating
        r1 = self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': 105}, headers=self.headers)
        self.assertEqual(r1.status_code, 422)
        r2 = self.client.post(f'/api/trips/{ID}/evaluation', json={'comfortRating': -5}, headers=self.headers)
        self.assertEqual(r2.status_code, 422)

        # Invalid score agreement choice
        r3 = self.client.post(f'/api/trips/{ID}/evaluation', json={'scoreAgreement': 'maybe'}, headers=self.headers)
        self.assertEqual(r3.status_code, 422)

        # Extra forbidden fields
        r4 = self.client.post(f'/api/trips/{ID}/evaluation', json={'unknownField': 123}, headers=self.headers)
        self.assertEqual(r4.status_code, 422)

if __name__ == '__main__':
    unittest.main()
