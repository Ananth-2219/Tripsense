"""Regression: browser verification must not replace preexisting artifacts."""
from pathlib import Path
import tempfile
import unittest
from analysis.ride_smoothness_v1.test_artifacts import preserve_browser_outputs

class TestArtifactPreservation(unittest.TestCase):
    def test_existing_browser_screenshots_restored_and_new_evidence_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            source=root/'.trip_maps/questionnaire'
            source.mkdir(parents=True)
            (source/'old.png').write_bytes(b'original')
            output=root/'new_run'
            with preserve_browser_outputs(root,output):
                (source/'old.png').write_bytes(b'replaced')
                (source/'new.json').write_text('new evidence')
            self.assertEqual((source/'old.png').read_bytes(),b'original')
            self.assertFalse((source/'new.json').exists())
            self.assertEqual((output/'browser_artifacts/old.png').read_bytes(),b'replaced')
            self.assertEqual((output/'browser_artifacts/new.json').read_text(),'new evidence')

    def test_restore_also_runs_when_suite_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            source=root/'.trip_maps/questionnaire'
            source.mkdir(parents=True)
            (source/'old.png').write_bytes(b'original')
            with self.assertRaises(RuntimeError):
                with preserve_browser_outputs(root,root/'new_run'):
                    (source/'old.png').write_bytes(b'replaced')
                    raise RuntimeError('suite failed')
            self.assertEqual((source/'old.png').read_bytes(),b'original')
