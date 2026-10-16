import tempfile
from pathlib import Path
import unittest

from trip_visualization.data import prepare_trip
from trip_visualization.maps import build_map, save_map
from test_trip_visualization import raw, gps


class FoliumMapTests(unittest.TestCase):
    def test_layers_replay_popups_and_safe_cache(self):
        readings=[gps(0),gps(1,78.0001),gps(2,78.0002),
                  dict(type='motion',timestamp=1792030432451,x=1,y=1,z=1)]
        events=[dict(start=.1,label='harsh_braking',confidence='high',severity='moderate',peak_a=8,
                     event_id='x</script>`${alert(1)}'),
                dict(start=1,label='harsh_acceleration'),dict(start=2,label='sharp_turn')]
        trip=prepare_trip(raw(readings),{},events)
        html=build_map(trip).get_root().render()
        for text in ['openstreetmap.org','Harsh braking','Harsh acceleration','Sharp turn',
                     'Speed (km/h)','Recorded GPS speed','GPS estimate','Severity','Confidence',
                     'Alignment','timestamped_geo_json','L.control.layers','Start','End']:
            self.assertIn(text,html)
        self.assertNotIn('${alert(1)}',html)
        self.assertNotIn('x</script>',html)
        with tempfile.TemporaryDirectory() as tmp:
            first=save_map(trip,Path(tmp)); before=first.stat().st_mtime_ns
            second=save_map(trip,Path(tmp))
            self.assertEqual(first,second)
            self.assertEqual(second.stat().st_mtime_ns,before)

    def test_no_gps_empty_state_and_optional_accuracy(self):
        trip=prepare_trip(raw([]),{},[])
        self.assertIn('No valid GPS fixes',build_map(trip).get_root().render())
        trip=prepare_trip(raw([gps(0,accuracy=5),gps(1,78.001,accuracy=6)]),{},[])
        html=build_map(trip,show_accuracy=True).get_root().render()
        self.assertIn('GPS accuracy',html)
        self.assertIn('radius',html)


if __name__ == '__main__': unittest.main()
