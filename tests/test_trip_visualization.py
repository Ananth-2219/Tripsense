"""Synthetic fixtures exercise quality rules; they are never demonstration data."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from trip_visualization.data import discover_trips, prepare_trip, MapOptions

ID = '24c3661c-2311-4063-93e0-75dd1fc9030c'
START = 1792030432451


def gps(seconds, lon=78.0, **extra):
    return dict(dict(type='location', timestamp=START + seconds*1000, lat=17.0, lon=lon), **extra)


def raw(readings):
    return dict(id=ID, started_at='2026-10-15T02:13:52.451+00:00', duration_seconds=30,
                motion_count=sum(r['type']=='motion' for r in readings),
                location_count=sum(r['type']=='location' for r in readings), readings=readings)


class ProcessingTests(unittest.TestCase):
    def test_chronological_valid_route_deduplicates_and_screens_speed(self):
        data = raw([gps(1,78.0001), gps(0), gps(1,78.0001), gps(1.001,78.0002), gps(20,78.001), gps(21,lat=999)])
        trip = prepare_trip(data, {}, [])
        self.assertEqual([p['timestamp'] for p in trip['points']], [START,START+1000,START+1001,START+20000])
        self.assertEqual(trip['quality']['invalid_gps'], 1)
        self.assertEqual(trip['quality']['duplicates'], 1)
        self.assertEqual(len(trip['segments']), 1)
        self.assertEqual([e['reason'] for e in trip['rejected_edges']], ['interval_under_0.5s','gap_over_5s'])
        self.assertEqual(trip['segments'][0]['speed_source'], 'GPS estimate')

    def test_event_alignment_never_crosses_a_gap_or_bad_accuracy(self):
        events = [dict(event_id='near', start=.25, label='harsh_braking', confidence='high', severity='high'),
                  dict(event_id='gap', start=10, label='harsh_acceleration', confidence='high'),
                  dict(event_id='far', start=21, label='sharp_turn', confidence='high')]
        trip = prepare_trip(raw([gps(0),gps(1,78.0001),gps(20,78.001,accuracy=100)]),{},events)
        self.assertEqual([e['event_id'] for e in trip['events']], ['near'])
        self.assertEqual(trip['events'][0]['alignment_delta_seconds'], .25)
        self.assertEqual({e['event_id'] for e in trip['unlocated_events']}, {'gap','far'})

    def test_sensor_exceedance_is_never_renamed_a_maneuver(self):
        events = [dict(event_id='sensor',start=.2,feature='combined',maneuver_label='uncertain',peak_a=20)]
        trip = prepare_trip(raw([gps(0),gps(1,78.0001),dict(type='motion',timestamp=START,x=1,y=1,z=1)]),{},events)
        self.assertEqual(trip['events'][0]['kind'], 'sensor_episode')
        self.assertEqual(trip['metrics']['maneuver_count'], 0)

    def test_missing_motion_suppresses_motion_claims_but_keeps_gps(self):
        event = dict(start=.1,label='harsh_braking',confidence='high',confirmation='motion_sensor')
        trip = prepare_trip(raw([gps(0),gps(1,78.0001)]),{},[event])
        self.assertEqual(len(trip['segments']),1)
        self.assertEqual(trip['metrics']['maneuver_count'],0)
        self.assertEqual(trip['unlocated_events'][0]['reason'],'motion_evidence_unavailable')

    def test_partial_motion_gap_cannot_support_a_motion_confirmed_label(self):
        readings=[gps(10),gps(11,78.0001),dict(type='motion',timestamp=START,x=1,y=1,z=1)]
        event=dict(start=10.1,label='harsh_braking',confirmation='motion_sensor')
        trip=prepare_trip(raw(readings),{},[event])
        self.assertFalse(trip['events'])
        self.assertEqual(trip['unlocated_events'][0]['reason'],'motion_evidence_unavailable')

    def test_recorded_speed_units_and_unknown_speed(self):
        trip = prepare_trip(raw([gps(0,speed=3),gps(1,78.0001,speed=4)]),{},[],options=MapOptions(estimate_speed=False))
        self.assertEqual(trip['segments'][0]['speed_kmh'],14.4)
        self.assertEqual(trip['segments'][0]['speed_source'],'Recorded GPS speed')
        unknown = prepare_trip(raw([gps(0),gps(1,78.0001)]),{},[],options=MapOptions(estimate_speed=False))
        self.assertIsNone(unknown['segments'][0]['speed_kmh'])
        self.assertIsNone(unknown['metrics']['average_speed_kmh'])

    def test_bad_accuracy_jump_and_conflicting_timestamp_break_route(self):
        for readings in [[gps(0),gps(1,79)], [gps(0),gps(1,78.0001,accuracy=80)]]:
            trip=prepare_trip(raw(readings),{},[])
            self.assertFalse(trip['segments'])
        trip=prepare_trip(raw([gps(0),gps(0,78.1),gps(1,78.0001)]),{},[])
        self.assertEqual(trip['quality']['conflicting_timestamps'],1)
        self.assertFalse(trip['segments'])

    def test_timezone_and_alignment_tolerance_boundary(self):
        event=dict(event_id='exact',timestamp='2026-10-15T07:43:53.451+05:30',label='sharp_turn',source='questionnaire')
        trip=prepare_trip(raw([gps(0),gps(2,78.0001)]),{},[event])
        self.assertEqual(trip['events'][0]['alignment_delta_seconds'],1)
        event['timestamp']='2026-10-15T02:13:53.452+00:00'
        trip=prepare_trip(raw([gps(0)]),{},[event])
        self.assertFalse(trip['events'])


class CatalogTests(unittest.TestCase):
    def test_only_successful_hash_bound_analysis_is_selectable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); good=root/'good'; good.mkdir()
            data=raw([gps(0),gps(1,78.0001)])
            path=good/(ID+'.json'); path.write_text(json.dumps(data))
            stats=dict(id=ID,raw_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),counts={'location':2})
            (good/'results.json').write_text(json.dumps({'trips':{'Target':stats}}))
            (good/'verification.json').write_text(json.dumps({'passed':True}))
            (good/'validation_and_sensitivity.json').write_text(json.dumps({'complete_ordinals':True,'invalid_records':[],'database_checksum_differences':{'timestamp':'0'}}))
            (root/'gps_only.json').write_text(json.dumps(data))
            self.assertEqual([t.id for t in discover_trips(root)[0]], [ID])
            (good/'verification.json').write_text(json.dumps({'passed':False}))
            self.assertFalse(discover_trips(root)[0])
            (good/'verification.json').write_text(json.dumps({'passed':True}))
            path.write_text(json.dumps(dict(data,duration_seconds=31)))
            self.assertFalse(discover_trips(root)[0])


if __name__ == '__main__':
    unittest.main()
