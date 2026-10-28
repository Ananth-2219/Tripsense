"""Regression tests for policy packaging integrity, CRLF preservation, and Vercel deployment."""
import hashlib, json, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class PolicyPackagingTests(unittest.TestCase):
    def test_reproduce_lf_normalization_causes_frozen_policy_mismatch(self):
        """Reproduce the exact Vercel failure: LF-only bytes cause policy verification mismatch."""
        baseline_path = ROOT / 'trip_scoring/policies/baseline_v1.json'
        expected_baseline_sha = (ROOT / 'trip_scoring/policies/baseline_v1.sha256').read_text().strip()
        
        # When read on Windows with CRLF, the hash matches the frozen seal
        original_bytes = baseline_path.read_bytes()
        self.assertIn(b'\r\n', original_bytes, 'Baseline policy file should contain CRLF line endings')
        self.assertEqual(hashlib.sha256(original_bytes).hexdigest(), expected_baseline_sha)
        
        # When Git checks out on Linux without .gitattributes, CRLF is stripped to LF:
        lf_bytes = original_bytes.replace(b'\r\n', b'\n')
        lf_sha = hashlib.sha256(lf_bytes).hexdigest()
        self.assertNotEqual(lf_sha, expected_baseline_sha)
        self.assertEqual(lf_sha, 'fb3dd2076416520b4172856f4bda1d1558f0db18c9a6e0eff704f53612ac6ba9')

        # Similarly for contextual policy v3:
        contextual_path = ROOT / 'trip_scoring/policies/contextual_v3.json'
        expected_contextual_sha = (ROOT / 'trip_scoring/policies/contextual_v3.sha256').read_text().strip()
        ctx_bytes = contextual_path.read_bytes()
        self.assertIn(b'\r\n', ctx_bytes, 'Contextual policy file should contain CRLF line endings')
        self.assertEqual(hashlib.sha256(ctx_bytes).hexdigest(), expected_contextual_sha)

        ctx_lf_bytes = ctx_bytes.replace(b'\r\n', b'\n')
        ctx_lf_sha = hashlib.sha256(ctx_lf_bytes).hexdigest()
        self.assertNotEqual(ctx_lf_sha, expected_contextual_sha)
        self.assertEqual(ctx_lf_sha, 'df84d58fa1eb00644fc7c24f246e8206362d56c9ac382e1d25c4531970b24e89')

    def test_gitattributes_configures_eol_crlf_for_all_policy_files(self):
        """Verify .gitattributes enforces CRLF line endings across all platforms."""
        gitattributes_path = ROOT / '.gitattributes'
        self.assertTrue(gitattributes_path.is_file(), '.gitattributes must exist at repository root')
        content = gitattributes_path.read_text(encoding='utf-8')
        self.assertIn('trip_scoring/policies/*.json text eol=crlf', content)
        self.assertIn('trip_scoring/policies/*.sha256 text eol=crlf', content)
        self.assertIn('analysis/** text eol=crlf', content)

        # Check that git attribute resolution confirms eol=crlf
        res = subprocess.run(
            ['git', 'check-attr', 'eol', '--', 'trip_scoring/policies/baseline_v1.json'],
            cwd=str(ROOT),
            capture_output=True,
            text=True
        )
        self.assertIn('eol: crlf', res.stdout)

        res_ctx = subprocess.run(
            ['git', 'check-attr', 'eol', '--', 'trip_scoring/policies/contextual_v3.json'],
            cwd=str(ROOT),
            capture_output=True,
            text=True
        )
        self.assertIn('eol: crlf', res_ctx.stdout)

    def test_clean_deployment_artifact_verifies_policy_hashes(self):
        """Verify that a clean Git clone with core.autocrlf=false (Linux/Vercel) preserves frozen hashes."""
        tmp_repo = Path(tempfile.mkdtemp())
        tmp_clone = Path(tempfile.mkdtemp())
        try:
            # 1. Clone into intermediate repo and commit .gitattributes
            subprocess.run(['git', 'clone', str(ROOT), str(tmp_repo)], check=True, capture_output=True)
            gitattributes_content = (ROOT / '.gitattributes').read_text(encoding='utf-8')
            (tmp_repo / '.gitattributes').write_text(gitattributes_content, encoding='utf-8')
            subprocess.run(['git', 'add', '.gitattributes'], cwd=tmp_repo, check=True, capture_output=True)
            subprocess.run(['git', 'commit', '-m', 'Add .gitattributes for packaging verification'], cwd=tmp_repo, check=True, capture_output=True)

            # 2. Clone with core.autocrlf=false simulating Linux Vercel build environment
            subprocess.run(['git', 'clone', '--config', 'core.autocrlf=false', str(tmp_repo), str(tmp_clone)], check=True, capture_output=True)

            # 3. Verify clean deployment bytes on disk match the expected frozen hashes
            clean_baseline = (tmp_clone / 'trip_scoring/policies/baseline_v1.json').read_bytes()
            expected_baseline_sha = (tmp_clone / 'trip_scoring/policies/baseline_v1.sha256').read_text().strip()
            self.assertEqual(hashlib.sha256(clean_baseline).hexdigest(), expected_baseline_sha)

            clean_ctx = (tmp_clone / 'trip_scoring/policies/contextual_v3.json').read_bytes()
            expected_ctx_sha = (tmp_clone / 'trip_scoring/policies/contextual_v3.sha256').read_text().strip()
            self.assertEqual(hashlib.sha256(clean_ctx).hexdigest(), expected_ctx_sha)

            # 4. Execute load_policy() inside the clean clone
            py_code = (
                "import sys\n"
                "sys.path.insert(0, '.')\n"
                "from trip_scoring.baseline import load_policy as load_baseline\n"
                "from trip_scoring.contextual import load_policy as load_contextual\n"
                "b = load_baseline()\n"
                "assert b['version'] == 'experimental-ride-smoothness/1.0.0'\n"
                "c = load_contextual()\n"
                "assert c['version'] == 'experimental-contextual-scoring/3.0.0'\n"
                "print('SUCCESS')\n"
            )
            python_exe = sys_python = Path(ROOT / '.venv-scoring/Scripts/python.exe')
            if not python_exe.is_file():
                import sys
                python_exe = Path(sys.executable)
            res = subprocess.run([str(python_exe), '-c', py_code], cwd=tmp_clone, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, f"load_policy failed in clean clone: {res.stderr}")
            self.assertIn('SUCCESS', res.stdout)
        finally:
            subprocess.run(['cmd', '/c', 'rmdir', '/s', '/q', str(tmp_clone)], capture_output=True)
            subprocess.run(['cmd', '/c', 'rmdir', '/s', '/q', str(tmp_repo)], capture_output=True)

    def test_vercel_routes_with_clean_policy(self):
        """Verify /api/health and /api/trips/{id}/score/retry succeed using the active policy."""
        from fastapi.testclient import TestClient
        from scoring_service.app import create_app
        from tests.live_service_support import MemoryRepository, payload, TOKEN, ID

        repo = MemoryRepository()
        trip_data = payload()
        repo.ingest(trip_data, TOKEN, 'fingerprint-123')
        app = create_app(repo)

        with TestClient(app) as client:
            # 1. GET /api/health loads baseline policy version without error
            health_res = client.get('/api/health')
            self.assertEqual(health_res.status_code, 200)
            self.assertEqual(health_res.json()['policyVersion'], 'experimental-ride-smoothness/1.0.0')

            # 2. POST /api/trips/{trip_id}/score/retry executes public_result without ValueError
            retry_res = client.post(
                f'/api/trips/{ID}/score/retry',
                headers={'Authorization': f'Bearer {TOKEN}', 'x-trip-input-fingerprint': 'fingerprint-123'}
            )
            self.assertEqual(retry_res.status_code, 200)
            data = retry_res.json()
            self.assertEqual(data['policyVersion'], 'experimental-ride-smoothness/1.0.0')
            self.assertEqual(data['tripSaved'], True)

            # 3. GET /api/trips/{trip_id}/score also succeeds
            score_res = client.get(
                f'/api/trips/{ID}/score',
                headers={'Authorization': f'Bearer {TOKEN}', 'x-trip-input-fingerprint': 'fingerprint-123'}
            )
            self.assertEqual(score_res.status_code, 200)
            self.assertEqual(score_res.json()['policyVersion'], 'experimental-ride-smoothness/1.0.0')
