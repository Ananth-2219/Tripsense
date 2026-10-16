import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest
from trip_visualization.data import discover_trips

APP=Path(__file__).resolve().parents[1]/'trip_visualization'/'app.py'


class InterfaceTests(unittest.TestCase):
    def test_empty_catalog_has_no_trip_selector(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'TRIPSENSE_ANALYSIS_DIR':tmp}):
            app=AppTest.from_file(str(APP)).run(timeout=30)
            self.assertFalse(app.exception)
            self.assertFalse(app.selectbox)
            self.assertIn('No successfully analyzed trips',app.info[0].value)

    def test_analyzed_selector_switch_and_options(self):
        eligible,_=discover_trips(APP.parents[1]/'analysis')
        if len(eligible)<2: self.skipTest('At least two local analyzed artifacts needed for selection integration')
        app=AppTest.from_file(str(APP)).run(timeout=30)
        self.assertFalse(app.exception)
        self.assertEqual(len(app.selectbox[0].options),len(eligible))
        self.assertEqual(len(app.metric),4)
        app.selectbox[0].select_index(1).run(timeout=30)
        self.assertFalse(app.exception)
        app.toggle[0].set_value(False).run(timeout=30)
        self.assertFalse(app.exception)
        self.assertEqual(app.metric[2].value,'Unavailable')
        app.toggle[2].set_value(True).run(timeout=30)
        self.assertFalse(app.exception)
        self.assertTrue(any('accuracy was not recorded' in x.value for x in app.info))


if __name__=='__main__': unittest.main()
