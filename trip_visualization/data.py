"""Analysis eligibility, GPS diagnostics and timestamp matching; no event detector."""
from collections import Counter, defaultdict
import csv
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
from pathlib import Path
from uuid import UUID


@dataclass(frozen=True)
class MapOptions:
    estimate_speed: bool = True
    event_tolerance_seconds: float = 1.0
    min_interval_seconds: float = .5
    max_gap_seconds: float = 5.0
    max_accuracy_m: float = 50.0
    max_speed_kmh: float = 160.0

    def __post_init__(self):
        if not (0 < self.event_tolerance_seconds <= 1 and 0 < self.min_interval_seconds <= self.max_gap_seconds
                and self.max_accuracy_m > 0 and self.max_speed_kmh > 0):
            raise ValueError('Invalid map quality options')


@dataclass(frozen=True)
class AnalyzedTrip:
    id: str
    label: str
    directory: Path
    raw_path: Path
    summary: dict
    raw_digest: str
    artifact_digest: str


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def numeric(value):
    try:
        result = float(value)
        return result if not isinstance(value, bool) and math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def timestamp_ms(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        number = numeric(value)
        return number if number is not None and 0 <= number <= 253402300799000 else None
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return dt.timestamp()*1000 if dt.tzinfo is not None else None
        except (ValueError, OverflowError, OSError):
            pass
    return None


def iso_time(value):
    return datetime.fromtimestamp(value/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def discover_trips(analysis_root):
    """Require completed results, validation, verification, counts AND a raw hash.

    Support the two real historical verification formats; a GPS-only export is
    never evidence of successful analysis. Corrupt/stale candidates are skipped.
    """
    trips, skipped, seen = [], [], set()
    for result_path in sorted(Path(analysis_root).glob('*/results.json')):
        directory = result_path.parent
        try:
            results = read_json(result_path)
            verification = read_json(directory/'verification.json')
            validation = read_json(directory/'validation_and_sensitivity.json')
            if (not isinstance(results,dict) or not isinstance(results.get('trips'),dict) or
                    not isinstance(validation,dict) or not isinstance(verification,(dict,list))):
                raise ValueError('Invalid analysis artifact structure')
            for label, summary in results['trips'].items():
                trip_id = str(UUID(summary['id']))
                try:
                    path = directory/(trip_id+'.json')
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    raw = read_json(path)
                    if (not isinstance(raw,dict) or not isinstance(raw.get('readings'),list) or
                            not all(isinstance(r,dict) for r in raw['readings'])):
                        raise ValueError('Invalid raw export structure')
                    check = validation.get(label, validation)
                    if not isinstance(check,dict): raise ValueError('Invalid validation structure')
                    deltas = check.get('database_checksum_differences', {})
                    validated = (check.get('invalid_records') == [] and isinstance(deltas,dict) and bool(deltas) and
                                 all(Decimal(str(d)).is_finite() and abs(Decimal(str(d))) < Decimal('1e-10') for d in deltas.values()))
                    if isinstance(verification, dict):
                        verified = verification.get('passed') is True and check.get('complete_ordinals') is True
                    else:
                        verified = any(isinstance(v,dict) and v.get('id') == trip_id and v.get('readings_length') == len(raw['readings']) for v in verification)
                    counts = Counter(r.get('type') for r in raw['readings'])
                    if (not verified or not validated or digest != summary.get('raw_sha256') or raw['id'] != trip_id or
                            dict(counts) != summary.get('counts') or len(raw['readings']) != sum(summary['counts'].values())):
                        raise ValueError('Missing, failed or stale analysis evidence')
                    if trip_id in seen:
                        raise ValueError('Duplicate analyzed trip ID')
                    seen.add(trip_id)
                    inputs = [result_path, directory/'verification.json', directory/'validation_and_sensitivity.json']
                    if (directory/'event_labels.csv').exists(): inputs.append(directory/'event_labels.csv')
                    artifact_hash = hashlib.sha256(b''.join(p.read_bytes() for p in inputs)).hexdigest()
                    trips.append(AnalyzedTrip(trip_id, label, directory, path, summary, digest, artifact_hash))
                except (OSError, ValueError, KeyError, TypeError, InvalidOperation) as exc:
                    skipped.append(f'{directory.name}/{trip_id}: {exc}')
        except (OSError, ValueError, KeyError, TypeError) as exc:
            skipped.append(f'{directory.name}: {exc}')
    return sorted(trips, key=lambda t: t.summary.get('started_at', ''), reverse=True), skipped


def load_events(trip):
    """Use existing labels when available; otherwise existing combined episodes.

    Never map 'high acceleration' to harsh acceleration, gyro to a sharp turn,
    or a trip named Harsh to a maneuver label. Exclude alternate merged rows.
    """
    label_file = trip.directory/'event_labels.csv'
    if label_file.exists():
        with label_file.open(encoding='utf-8-sig', newline='') as handle:
            return [r for r in csv.DictReader(handle) if r.get('definition', 'contiguous') == 'contiguous'
                    and (r.get('feature') == 'combined' or r.get('maneuver_label') in MANEUVERS or r.get('label') in MANEUVERS)]
    episodes = trip.summary.get('events_p95', {}).get('combined', {}).get('episodes', [])
    return [dict(e, event_id=f'combined-contiguous-{i:04d}', feature='combined', maneuver_label='uncertain',
                 observation_confidence='Recorded threshold exceedance; cause uncertain',
                 source='results.json / events_p95 / combined') for i, e in enumerate(episodes, 1)]


MANEUVERS = {'harsh_braking': 'Harsh braking', 'harsh_acceleration': 'Harsh acceleration', 'sharp_turn': 'Sharp turn'}


def haversine(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b['lon']-a['lon'])/2)**2
    return 6371008.8*2*math.asin(math.sqrt(min(1, max(0, h))))


def prepare_trip(raw, summary, events, *, options=MapOptions()):
    """Return observations and explicitly screened visual estimates; never labels."""
    quality = Counter(invalid_gps=0, duplicates=0, conflicting_timestamps=0, accuracy_missing=0)
    groups = defaultdict(list)
    for row in raw.get('readings', []):
        if row.get('type') != 'location': continue
        lat, lon, ts = numeric(row.get('lat')), numeric(row.get('lon')), timestamp_ms(row.get('timestamp'))
        if lat is None or lon is None or ts is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            quality['invalid_gps'] += 1; continue
        accuracy = numeric(row.get('accuracy'))
        if accuracy is not None and accuracy < 0: accuracy = None
        speed = numeric(row.get('speed'))  # Geolocation API speed is m/s; no unit guessing.
        if speed is not None and speed < 0: speed = None
        point = dict(lat=lat, lon=lon, timestamp=ts, accuracy=accuracy, speed_mps=speed)
        if point in groups[ts]: quality['duplicates'] += 1
        else: groups[ts].append(point)
    points = []
    conflict_times = []
    for ts, group in sorted(groups.items()):
        if len(group) > 1:
            quality['conflicting_timestamps'] += 1; conflict_times.append(ts)
        else: points.append(group[0])
    quality['accuracy_missing'] = sum(p['accuracy'] is None for p in points)
    segments, rejected = [], []
    for i, (a, b) in enumerate(zip(points, points[1:])):
        seconds = (b['timestamp']-a['timestamp'])/1000
        distance = haversine(a, b)
        implied_kmh = distance/seconds*3.6
        reason = None
        if any(a['timestamp'] <= t <= b['timestamp'] for t in conflict_times): reason = 'conflicting_timestamp'
        elif seconds < options.min_interval_seconds: reason = 'interval_under_0.5s'
        elif seconds > options.max_gap_seconds: reason = 'gap_over_5s'
        elif any(p['accuracy'] is not None and p['accuracy'] > options.max_accuracy_m for p in [a,b]): reason = 'poor_accuracy'
        elif implied_kmh > options.max_speed_kmh: reason = 'implausible_gps_jump'
        if reason:
            rejected.append(dict(start=a['timestamp'],end=b['timestamp'],reason=reason,diagnostic_speed_kmh=implied_kmh))
            continue
        speed, source = None, 'Unavailable'
        if b['speed_mps'] is not None and b['speed_mps']*3.6 <= options.max_speed_kmh:
            speed, source = b['speed_mps']*3.6, 'Recorded GPS speed'
        elif options.estimate_speed:
            error = sum(p['accuracy'] or 0 for p in [a,b])
            if distance > error or error == 0:
                speed, source = implied_kmh, 'GPS estimate'
        segments.append(dict(start=a,end=b,start_index=i,end_index=i+1,seconds=seconds,distance_m=distance,
                             speed_kmh=speed,speed_source=source))
    # A fix must touch a screened edge to support an event location. Unknown
    # accuracy is disclosed, not silently treated as measured zero error.
    supported = {i for seg in segments for i in [seg['start_index'],seg['end_index']]}
    motion = [r for r in raw.get('readings', []) if r.get('type') == 'motion']
    accel_times, rotation_times = [], []
    for row in motion:
        ts = timestamp_ms(row.get('timestamp'))
        if ts is None: continue
        if all(numeric(row.get(k)) is not None for k in ['x','y','z']): accel_times.append(ts)
        if all(numeric(row.get(k)) is not None for k in ['rotationAlpha','rotationBeta','rotationGamma']): rotation_times.append(ts)
    start_ms = timestamp_ms(raw.get('started_at'))
    located, unlocated = [], []
    for original in events:
        event = dict(original)
        label = event.get('maneuver_label') if event.get('maneuver_label') in MANEUVERS else event.get('label')
        event['kind'] = label if label in MANEUVERS else 'sensor_episode'
        event.setdefault('event_id', f"event-{len(located)+len(unlocated)+1}")
        explicit_time = event.get('timestamp') not in (None,'')
        ts = timestamp_ms(event.get('timestamp'))
        if not explicit_time and start_ms is not None:
            elapsed = numeric(event.get('peak_elapsed', event.get('start')))
            ts = start_ms + elapsed*1000 if elapsed is not None else None
        event['timestamp_ms'] = ts
        if ts is None:
            event['reason'] = 'invalid_event_timestamp'; unlocated.append(event); continue
        requires_motion = (event['kind']=='sensor_episode' or event.get('confirmation')=='motion_sensor' or
                           event.get('source')=='motion_sensor')
        local_times = (rotation_times if event['kind']=='sharp_turn' else accel_times if event['kind'] in
                       ['harsh_braking','harsh_acceleration'] else accel_times+rotation_times)
        if requires_motion and not any(abs(t-ts)<=500 for t in local_times):
            event['reason'] = 'motion_evidence_unavailable'; unlocated.append(event); continue
        candidates = [(abs(p['timestamp']-ts),i,p) for i,p in enumerate(points) if i in supported]
        if not candidates:
            event['reason'] = 'no_reliable_gps_fix'; unlocated.append(event); continue
        delta, index, point = min(candidates, key=lambda item:(item[0],item[1]))
        if delta/1000 > options.event_tolerance_seconds:
            event['reason'] = 'no_fix_within_tolerance'; unlocated.append(event); continue
        event.update(point=point,alignment_delta_seconds=delta/1000,location_accuracy_recorded=point['accuracy'] is not None)
        incident = [s for s in segments if index in [s['start_index'],s['end_index']]]
        previous = [s for s in incident if s['end_index']==index]
        speed_segment = (previous or incident)[0]
        event.update(speed_kmh=speed_segment['speed_kmh'],speed_source=speed_segment['speed_source'])
        located.append(event)
    duration = numeric(raw.get('duration_seconds'))
    valid_speeds = [s for s in segments if s['speed_kmh'] is not None]
    speed_time = sum(s['seconds'] for s in valid_speeds)
    support = numeric(summary.get('observed_support'))
    metrics = dict(duration_seconds=duration,observed_distance_km=sum(s['distance_m'] for s in segments)/1000,
                   average_speed_kmh=sum(s['speed_kmh']*s['seconds'] for s in valid_speeds)/speed_time if speed_time else None,
                   max_speed_kmh=max((s['speed_kmh'] for s in valid_speeds),default=None),
                   gps_supported_seconds=sum(s['seconds'] for s in segments),
                   motion_support_percent=support/duration*100 if support is not None and duration else None,
                   maneuver_count=sum(e['kind'] in MANEUVERS for e in located),
                   sensor_episode_count=sum(e['kind']=='sensor_episode' for e in located),
                   unmatched_event_count=len(unlocated),motion_readings=len(motion),gps_fixes=len(points))
    quality['rejected_edges'] = len(rejected)
    return dict(id=raw['id'],points=points,segments=segments,rejected_edges=rejected,events=located,
                unlocated_events=unlocated,metrics=metrics,quality=dict(quality),options=options,
                summary=summary,started_at=raw.get('started_at'))
