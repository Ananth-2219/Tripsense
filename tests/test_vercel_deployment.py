"""Verify Vercel deployment configuration, serverless entrypoint, and route accessibility."""
import json, os, unittest
from pathlib import Path
from fastapi.testclient import TestClient
from api.index import app

ROOT = Path(__file__).resolve().parents[1]

class VercelDeploymentTests(unittest.TestCase):
    def test_vercel_serverless_entrypoint_exports_fastapi_app(self):
        self.assertEqual(app.title, 'TripSense baseline scoring')

    def test_required_api_routes_are_mounted(self):
        routes = {(r.path, tuple(r.methods - {'HEAD', 'OPTIONS'})) for r in app.routes if hasattr(r, 'methods')}
        required = [
            ('/api/health', ('GET',)),
            ('/api/trips', ('POST',)),
            ('/api/trips/{trip_id}/score', ('GET',)),
            ('/api/trips/{trip_id}/score/retry', ('POST',)),
            ('/api/trips/{trip_id}/score/finalize', ('POST',)),
            ('/api/trips/{trip_id}/evaluation', ('GET',)),
            ('/api/trips/{trip_id}/evaluation', ('POST',)),
        ]
        for path, methods in required:
            matching = [r for r in app.routes if getattr(r, 'path', None) == path and any(m in getattr(r, 'methods', set()) for m in methods)]
            self.assertTrue(len(matching) > 0, f'Route {methods} {path} not mounted on FastAPI app')

    def test_health_endpoint_accessible(self):
        with TestClient(app) as client:
            res = client.get('/api/health')
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data.get('service'), 'baseline')
            self.assertEqual(data.get('policyVersion'), 'experimental-ride-smoothness/1.0.0')

    def test_unauthenticated_trip_routes_reject_safely(self):
        # 1. Unconfigured environment fails closed with 503 configuration_required
        with TestClient(app) as client:
            res = client.get('/api/trips/00000000-0000-0000-0000-000000000000/score')
            self.assertEqual(res.status_code, 503)
            self.assertEqual(res.json()['error']['code'], 'configuration_required')

        # 2. Configured environment rejects missing/invalid Bearer token with 401
        from scoring_service.app import create_app
        from tests.live_service_support import MemoryRepository
        configured_app = create_app(MemoryRepository())
        with TestClient(configured_app) as client:
            res = client.get('/api/trips/00000000-0000-0000-0000-000000000000/score')
            self.assertEqual(res.status_code, 401)
            eval_res = client.get('/api/trips/00000000-0000-0000-0000-000000000000/evaluation')
            self.assertEqual(eval_res.status_code, 401)
            eval_post = client.post('/api/trips/00000000-0000-0000-0000-000000000000/evaluation', json={})
            self.assertEqual(eval_post.status_code, 401)


    def test_vercel_json_configuration(self):
        vercel_json_path = ROOT / 'vercel.json'
        self.assertTrue(vercel_json_path.is_file(), 'vercel.json must exist at root')
        config = json.loads(vercel_json_path.read_text(encoding='utf-8'))
        self.assertEqual(config.get('outputDirectory'), 'dist')
        self.assertEqual(config.get('framework'), 'vite')
        rewrites = config.get('rewrites', [])
        self.assertGreaterEqual(len(rewrites), 2)
        # API rewrite must precede SPA fallback
        self.assertEqual(rewrites[0]['source'], '/api/:path*')
        self.assertEqual(rewrites[0]['destination'], '/api/index.py')
        self.assertEqual(rewrites[1]['destination'], '/index.html')

    def test_vercelignore_excludes_heavy_artifacts(self):
        ignore_path = ROOT / '.vercelignore'
        self.assertTrue(ignore_path.is_file(), '.vercelignore must exist at root')
        content = ignore_path.read_text(encoding='utf-8')
        for expected in ['.venv', 'analysis', '.trip_maps', 'tests', '.env']:
            self.assertIn(expected, content)

    def test_requirements_txt_exists_and_contains_runtime_deps(self):
        req_path = ROOT / 'requirements.txt'
        self.assertTrue(req_path.is_file(), 'requirements.txt must exist for Vercel')
        content = req_path.read_text(encoding='utf-8')
        for dep in ['fastapi', 'uvicorn', 'pydantic', 'httpx', 'numpy', 'pandas']:
            self.assertIn(dep, content)
