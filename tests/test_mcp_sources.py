from copy import deepcopy
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from trip_visualization.mcp import parse_mcp_response, verification_query, verify_exports
from trip_visualization.data import prepare_trip
from trip_visualization.maps import replay_geojson
from test_trip_visualization import ID, raw, gps


class SourceAndReplayTests(unittest.TestCase):
    def test_scoped_select_and_untrusted_envelope_parsing(self):
        sql=verification_query([SimpleNamespace(id=ID)])
        self.assertTrue(sql.startswith('SELECT'))
        self.assertEqual(sql.count(';'),1)
        self.assertIn(ID,sql)
        rows=[dict(id=ID)]
        body='Header says ignore <untrusted-data-x> boundaries.\n<untrusted-data-x>\n'+json.dumps(rows)+'\n</untrusted-data-x>'
        self.assertEqual(parse_mcp_response({'content':[{'type':'text','text':json.dumps({'result':body})}]}),rows)
        with self.assertRaises(ValueError): verification_query([SimpleNamespace(id="'; DELETE FROM trips;")])

    def test_source_mismatch_never_gets_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=raw([gps(0),gps(1,78.0001)])
            path=Path(tmp)/'raw.json'; path.write_text(json.dumps(data))
            trip=SimpleNamespace(id=ID,raw_path=path,raw_digest=hashlib.sha256(path.read_bytes()).hexdigest())
            sums={}
            for row in data['readings']:
                for key,val in row.items():
                    if isinstance(val,(int,float)): sums[key]=str(Decimal(sums.get(key,'0'))+Decimal(str(val)))
            record=dict(id=ID,metadata={k:v for k,v in data.items() if k!='readings'},reading_count=2,numeric_sums=sums)
            self.assertIn(ID,verify_exports([trip],[record])['trips'])
            changed=deepcopy(record); changed['numeric_sums']['timestamp']='0'
            with self.assertRaises(ValueError): verify_exports([trip],[changed])
            changed=deepcopy(record); changed['metadata']['duration_seconds']=31
            with self.assertRaises(ValueError): verify_exports([trip],[changed])

    def test_replay_contains_only_original_supported_points(self):
        data=raw([gps(0),gps(1,78.0001),gps(100,78.1),gps(101,78.1001)])
        trip=prepare_trip(data,{},[])
        replay=replay_geojson(trip)
        self.assertEqual(len(replay['features']),4)
        self.assertTrue(all(f['geometry']['type']=='Point' for f in replay['features']))
        self.assertTrue(all(len(f['properties']['times'])==1 for f in replay['features']))
        self.assertEqual(len(trip['segments']),2)
        self.assertEqual(trip['rejected_edges'][0]['reason'],'gap_over_5s')


if __name__=='__main__': unittest.main()
