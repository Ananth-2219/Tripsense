"""Reusable Folium generator and content-addressed local HTML cache."""
import argparse
from dataclasses import asdict
import hashlib
from html import escape
import json
from pathlib import Path
from uuid import UUID

import folium
from folium.plugins import Fullscreen, TimestampedGeoJson

from .data import MANEUVERS, discover_trips, iso_time, load_events, prepare_trip, read_json

SPEED_COLORS = ['#2563eb','#0f766e','#65a30d','#d97706','#be185d']
EVENT_COLORS = {'harsh_braking':'red','harsh_acceleration':'orange','sharp_turn':'purple','sensor_episode':'gray'}


def safe(value):
    # Folium popups use JS template literals as well as HTML. Escape both contexts.
    return escape(str(value)).replace('`','&#96;').replace('$','&#36;')


def shown(value, unit=''):
    return f'{value:.1f}{unit}' if isinstance(value,(float,int)) else 'Unavailable'


def speed_color(speed):
    if speed is None: return '#64748b'
    return SPEED_COLORS[next((i for i,limit in enumerate([20,40,60,80]) if speed < limit),4)]


def event_popup(event):
    name = MANEUVERS.get(event['kind'],'Sensor episode — maneuver uncertain')
    pairs = [('Event',name),('ID',event['event_id']),('Timestamp (UTC)',iso_time(event['timestamp_ms'])),
             ('Speed',shown(event['speed_kmh'],' km/h')+' · '+event['speed_source']),
             ('Severity',event.get('severity') or 'Not assigned by analysis'),
             ('Confidence',event.get('confidence') or event.get('observation_confidence') or 'Not supplied'),
             ('Maneuver confidence',event.get('maneuver_confidence') or 'Not supplied'),
             ('Source',event.get('source') or 'Existing event_labels.csv; no new detection'),
             ('Alignment',f"nearest observed fix; delta {event['alignment_delta_seconds']:.3f}s"),
             ('GPS fix time',iso_time(event['point']['timestamp'])),
             ('Accuracy',shown(event['point']['accuracy'],' m'))]
    for key,unit in [('peak_a',' m/s²'),('peak_absjerk',' m/s³'),('peak_gyro',' deg/s')]:
        if key in event:
            pairs.append((key,str(event[key])+unit))
    for key in ['movement_status','movement_confidence','questionnaire_corroboration','confirmation']:
        if event.get(key): pairs.append((key,event[key]))
    return '<table>'+''.join(f'<tr><th style="text-align:left;padding-right:10px">{safe(k)}</th><td>{safe(v)}</td></tr>' for k,v in pairs)+'</table>'


def replay_geojson(trip):
    """Observed points only; never interpolated coordinates or gap-spanning lines."""
    features = []
    supported = {i for s in trip['segments'] for i in [s['start_index'],s['end_index']]}
    for index, point in enumerate(trip['points']):
        if index not in supported: continue
        features.append(dict(type='Feature',geometry=dict(type='Point',coordinates=[point['lon'],point['lat']]),
                             properties=dict(times=[iso_time(point['timestamp'])],
                                             popup=safe('Observed fix · '+iso_time(point['timestamp'])),
                                             icon='circle',iconstyle=dict(radius=6,fillColor='#111827',fillOpacity=.9,color='white',weight=1))))
    return dict(type='FeatureCollection',features=features)


def build_map(trip, *, include_replay=True, show_accuracy=False):
    points = trip['points']
    center = [points[0]['lat'],points[0]['lon']] if points else [20,0]
    m = folium.Map(location=center,tiles='OpenStreetMap',zoom_start=13 if points else 2,
                   control_scale=True,width='100%',height='100%',prefer_canvas=True)
    Fullscreen().add_to(m)
    route = folium.FeatureGroup(name='Chronological GPS route',show=False).add_to(m)
    speeds = folium.FeatureGroup(name='Speed (km/h) — screened observations / estimates',show=True).add_to(m)
    fixes = folium.FeatureGroup(name='Observed GPS fixes',show=False).add_to(m)
    for point in points:
        folium.CircleMarker([point['lat'],point['lon']],radius=2,color='#475569',weight=1,
                            popup=f'Observed fix · {iso_time(point["timestamp"])}',fill=True).add_to(fixes)
    for segment in trip['segments']:
        coords = [[segment[key]['lat'],segment[key]['lon']] for key in ['start','end']]
        folium.PolyLine(coords,color='#475569',weight=3,opacity=.6).add_to(route)
        text = (f"{iso_time(segment['start']['timestamp'])} → {iso_time(segment['end']['timestamp'])}<br>"
                f"{shown(segment['speed_kmh'],' km/h')} · {segment['speed_source']}<br>"
                f"Observed chord: {segment['distance_m']:.1f} m / {segment['seconds']:.3f}s")
        folium.PolyLine(coords,color=speed_color(segment['speed_kmh']),weight=5,opacity=.85,
                        tooltip=f"{shown(segment['speed_kmh'],' km/h')} · {segment['speed_source']}",
                        popup=folium.Popup(text,max_width=340)).add_to(speeds)
    endpoints = folium.FeatureGroup(name='Start / end fixes').add_to(m)
    if points:
        for name,point,color,icon in [('Start',points[0],'green','play'),('End',points[-1],'black','stop')]:
            folium.Marker([point['lat'],point['lon']],tooltip=name+' observed GPS fix',
                          popup=f'{name} observed fix<br>{iso_time(point["timestamp"])}',
                          icon=folium.Icon(color=color,icon=icon,prefix='fa')).add_to(endpoints)
        m.fit_bounds([[p['lat'],p['lon']] for p in points],padding=(30,30))
    layers = {kind:folium.FeatureGroup(name=title+' — existing labels',show=True).add_to(m) for kind,title in MANEUVERS.items()}
    layers['sensor_episode'] = folium.FeatureGroup(name='Sensor episodes — cause uncertain',show=False).add_to(m)
    for event in trip['events']:
        kind = event['kind']
        folium.Marker([event['point']['lat'],event['point']['lon']],
                      tooltip=MANEUVERS.get(kind,'Sensor episode — maneuver uncertain'),
                      popup=folium.Popup(event_popup(event),max_width=380),
                      icon=folium.Icon(color=EVENT_COLORS[kind],icon='info-sign')).add_to(layers[kind])
    if show_accuracy and any(p['accuracy'] is not None for p in points):
        accuracy = folium.FeatureGroup(name='GPS accuracy — recorded radius (m)',show=False).add_to(m)
        for point in points:
            if point['accuracy'] is not None:
                folium.Circle([point['lat'],point['lon']],radius=point['accuracy'],color='#0284c7',weight=1,
                              fill=True,fill_opacity=.06,tooltip=f"Recorded GPS accuracy: {point['accuracy']:.1f} m").add_to(accuracy)
    replay = replay_geojson(trip)
    if include_replay and len(replay['features']) >= 2:
        TimestampedGeoJson(replay,period='PT1S',duration='PT1S',add_last_point=False,
                           auto_play=False,loop=False,max_speed=50,transition_time=100,
                           time_slider_drag_update=True,date_options='YYYY-MM-DD HH:mm:ss [UTC]').add_to(m)
    folium.LayerControl(collapsed=True).add_to(m)
    metric = trip['metrics']
    bands = ['0–20','20–40','40–60','60–80','80–160']
    swatches = ''.join(f'<span style="display:inline-block;margin:2px 5px 2px 0"><b style="color:{c}">━</b> {b}</span>' for c,b in zip(SPEED_COLORS,bands))
    legend = f'''<div class="trip-legend" role="note" aria-label="Speed and event legend">
    <b>Speed (km/h)</b><br>{swatches}<br><span style="color:#64748b">━</span> Speed unavailable<br>
    Recorded GPS speed when present; otherwise GPS estimate.<hr style="margin:5px 0">
    <span style="color:red">●</span> Harsh braking · <span style="color:#c2410c">●</span> Harsh acceleration<br>
    <span style="color:purple">●</span> Sharp turn · <span style="color:#64748b">●</span> Sensor episode (uncertain cause)<hr style="margin:5px 0">
    {shown(metric['duration_seconds'],' s')} session · {metric['observed_distance_km']:.2f} km observed chords<br>
    Avg {shown(metric['average_speed_kmh'],' km/h')} · Max {shown(metric['max_speed_kmh'],' km/h')}<br>
    {metric['maneuver_count']} mapped maneuver labels · {metric['sensor_episode_count']} sensor episodes<br>
    {metric['unmatched_event_count']} unmatched events · gaps are not connected.<br>
    Event match ≤{trip['options'].event_tolerance_seconds:g}s; no position interpolation.
    {'' if points else '<br><b>No valid GPS fixes</b>'}</div>'''
    style = '''<style>.trip-legend{position:fixed;bottom:70px;right:12px;z-index:999;
    background:rgba(255,255,255,.96);color:#17212e;border:1px solid #cbd5e1;padding:10px;
    font:11px/1.4 Arial,sans-serif;width:280px;max-width:60vw;max-height:45%;overflow:auto;}
    .leaflet-control-timecontrol{max-width:calc(100vw - 30px)}
    @media(max-width:600px){.trip-legend{bottom:80px;width:210px;font-size:10px;padding:6px;max-height:32%;}}
    </style>'''
    m.get_root().html.add_child(folium.Element(style+legend))
    return m


def save_map(trip, cache_dir, *, include_replay=True, show_accuracy=False):
    content = json.dumps(dict(trip=trip,replay=include_replay,accuracy=show_accuracy),sort_keys=True,default=lambda o:asdict(o))
    code = Path(__file__).read_bytes()+(Path(__file__).parent/'data.py').read_bytes()
    digest = hashlib.sha256(content.encode()+code).hexdigest()[:20]
    cache_dir = Path(cache_dir); cache_dir.mkdir(parents=True,exist_ok=True)
    path = cache_dir/f'{UUID(trip["id"])}-{digest}.html'
    if not path.exists(): build_map(trip,include_replay=include_replay,show_accuracy=show_accuracy).save(str(path))
    return path


def main():
    repo=Path(__file__).resolve().parents[1]
    parser=argparse.ArgumentParser(description='Generate a Folium HTML map for a verified analyzed trip')
    parser.add_argument('--trip',required=True)
    parser.add_argument('--analysis-root',type=Path,default=repo/'analysis')
    parser.add_argument('--cache-dir',type=Path,default=repo/'.trip_maps'/'html')
    args=parser.parse_args()
    trips,_=discover_trips(args.analysis_root)
    record=next((t for t in trips if t.id==args.trip),None)
    if record is None: parser.error('Trip has no successful, hash-verified analysis')
    trip=prepare_trip(read_json(record.raw_path),record.summary,load_events(record))
    print(save_map(trip,args.cache_dir))


if __name__=='__main__': main()
