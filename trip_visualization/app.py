"""Run: python -m streamlit run trip_visualization/app.py"""
import os
from pathlib import Path

import streamlit as st
from streamlit_folium import st_folium

from trip_visualization.data import (MANEUVERS, MapOptions, discover_trips, iso_time,
                                     load_events, prepare_trip, read_json)
from trip_visualization.maps import build_map, save_map, shown

REPO = Path(__file__).resolve().parents[1]


@st.cache_data(show_spinner=False)
def prepared(raw_path, raw_digest, artifact_digest, summary, events, options):
    # Digest arguments invalidate the cache when source/artifact content changes.
    return prepare_trip(read_json(raw_path),summary,events,options=options)


def main():
    st.set_page_config(page_title='TripSense · Trip Explorer',page_icon='🗺️',layout='wide')
    st.title('TripSense · Trip Explorer')
    st.caption('Analyzed trips · observed GPS routes · evidence-aware event labels')
    root = Path(os.environ.get('TRIPSENSE_ANALYSIS_DIR',REPO/'analysis'))
    trips, skipped = discover_trips(root)
    if not trips:
        st.info('No successfully analyzed trips are available. GPS recordings alone do not qualify. See trip_visualization/README.md for the required analysis artifacts.')
        if skipped:
            with st.expander('Analysis validation details'): st.write(skipped)
        return
    with st.sidebar:
        st.header('Trip selection')
        st.caption(f'{len(trips)} validated analyses')
        selected = st.selectbox('Analyzed trip',range(len(trips)),format_func=lambda i:
                                f"{trips[i].summary.get('started_at','Date unavailable')[:10]} · {trips[i].label} · {trips[i].id[:8]}")
        st.divider()
        st.subheader('Map options')
        estimate = st.toggle('Estimate missing speed from GPS',value=True)
        replay = st.toggle('Enable timestamp replay',value=True)
        accuracy = st.toggle('Include recorded GPS accuracy',value=False)
        tolerance = st.slider('Event alignment tolerance (seconds)',min_value=.25,max_value=1.0,value=1.0,step=.25)
        st.caption('Nearest screened GPS fix only. No coordinate interpolation; events outside this limit remain unlocated.')
        if skipped:
            with st.expander('Excluded analysis artifacts'): st.write(skipped)
    record = trips[selected]
    options = MapOptions(estimate_speed=estimate,event_tolerance_seconds=tolerance)
    with st.spinner('Preparing observed route and existing labels…'):
        trip = prepared(str(record.raw_path),record.raw_digest,record.artifact_digest,record.summary,load_events(record),options)
    metric = trip['metrics']
    st.subheader(record.id)
    st.caption(f"Analysis: {record.label} · stored start: {trip['started_at']} · historical trip names are supplied conditions, not maneuver predictions")
    source = REPO/'.trip_maps'/'source_manifest.json'
    try:
        manifest = read_json(source)
        bound = manifest['trips'].get(record.id,{})
        if bound.get('raw_sha256') == record.raw_digest:
            st.caption(f"Source: public.trips · supabase_trips_readonly · last checksum check {manifest['checked_at']} · local analyzed snapshot")
        else: st.caption('Local analyzed snapshot; its current content has not been rechecked against Supabase. See the MCP refresh instructions.')
    except (OSError,ValueError,KeyError):
        st.caption('Local analyzed Supabase export. A fresh MCP verification can be imported using the documented read-only workflow.')
    duration = metric['duration_seconds']
    values = [f'{int(duration//60)}m {duration%60:.0f}s' if duration is not None else 'Unavailable',
              f"{metric['observed_distance_km']:.2f} km",shown(metric['average_speed_kmh'],' km/h'),shown(metric['max_speed_kmh'],' km/h')]
    for col,label,value in zip(st.columns(4),['Session duration','Observed GPS chords','Avg speed · screened','Max speed · screened'],values): col.metric(label,value)
    st.caption('Distance excludes rejected edges and missing intervals. Speeds are GPS estimates unless recorded speed exists; average is time-weighted over accepted speed segments, not the full session.')
    if metric['motion_support_percent'] is not None and metric['motion_support_percent'] < 90:
        st.warning(f"Motion support covers {metric['motion_support_percent']:.1f}% of the session. Missing intervals cannot establish quiet riding or an absence of events.")
    if not metric['motion_readings']:
        st.info('GPS-only trip: motion-sensor-confirmed maneuvers cannot be established. Existing non-sensor labels retain their supplied evidence status.')
    counts = [f"{metric['maneuver_count']} mapped maneuver labels",f"{metric['sensor_episode_count']} mapped sensor episodes",f"{metric['unmatched_event_count']} unlocated events"]
    st.write(' · '.join(counts))
    st.caption('Red = existing harsh braking · Orange = existing harsh acceleration · Purple = existing sharp turn · Gray = sensor episode, physical cause uncertain. Empty maneuver layers mean no such labels were supplied.')
    st_folium(build_map(trip,include_replay=replay,show_accuracy=accuracy),height=620,
              use_container_width=True,returned_objects=[],key=f'map-{record.id}-{estimate}-{replay}-{accuracy}-{tolerance}')
    st.caption('Open the layer control to toggle speed, route, observed fixes and event layers. Replay shows timestamped observed fixes only; no marker is carried across recording gaps.')
    if accuracy and not any(p['accuracy'] is not None for p in trip['points']):
        st.info('GPS accuracy was not recorded for this trip; no accuracy circles are drawn.')
    try:
        path = save_map(trip,REPO/'.trip_maps'/'html',include_replay=replay,show_accuracy=accuracy)
        st.download_button('Download interactive Folium map',path.read_bytes(),file_name=record.id+'-map.html',mime='text/html')
    except OSError:
        st.info('The map is available above; the local HTML cache could not be written.')
    evidence, quality, method = st.tabs(['Event evidence','Data quality','Method & provenance'])
    with evidence:
        st.write('Existing labels only. Sensor magnitude excursions are never renamed braking, acceleration, or sharp turns.')
        rows=[]
        for event in trip['events']:
            rows.append(dict(event=event['event_id'],label=MANEUVERS.get(event['kind'],'Sensor episode — cause uncertain'),
                             timestamp_utc=iso_time(event['timestamp_ms']),speed_kmh=event['speed_kmh'],
                             speed_source=event['speed_source'],severity=event.get('severity') or 'Not assigned',
                             confidence=event.get('confidence') or event.get('observation_confidence') or 'Not supplied',
                             maneuver_confidence=event.get('maneuver_confidence') or 'Not supplied',
                             alignment_seconds=event['alignment_delta_seconds']))
        if rows: st.dataframe(rows,hide_index=True,width='stretch')
        else: st.info('No existing events have a reliable GPS match for these settings.')
        st.subheader('Events without a reliable location')
        if trip['unlocated_events']:
            st.dataframe([dict(event=e['event_id'],reason=e['reason'],timestamp_utc=iso_time(e['timestamp_ms']) if e['timestamp_ms'] is not None else 'Unavailable') for e in trip['unlocated_events']],hide_index=True,width='stretch')
        else: st.write('None with the current tolerance.')
    with quality:
        st.json(dict(trip['quality'],gps_fixes=metric['gps_fixes'],motion_readings=metric['motion_readings'],
                     motion_support_percent=metric['motion_support_percent'],gps_supported_seconds=metric['gps_supported_seconds']))
        st.write('Missing accuracy is unknown, not zero error. Recorded accuracy above 50m, intervals below 0.5s or above 5s, conflicting timestamps, and apparent jumps above 160 km/h reject an edge. These are visualization-quality screens, not safety or legal limits.')
        if trip['rejected_edges']:
            st.dataframe([dict(start_utc=iso_time(e['start']),end_utc=iso_time(e['end']),reason=e['reason'],unvalidated_diagnostic_kmh=e['diagnostic_speed_kmh']) for e in trip['rejected_edges']],hide_index=True,width='stretch')
    with method:
        st.write('Eligibility requires completed analysis artifacts, passing validation, matching source counts and a matching raw-export SHA256. GPS availability alone is insufficient.')
        st.write('The prior analysis uses acceleration/rotation magnitudes, scalar-magnitude jerk, frozen empirical thresholds and midpoint-supported episodes. It does not provide a validated riding-maneuver classifier. No new event detection runs in this viewer.')
        st.write('Event timestamps use the supplied absolute timestamp, or the supplied peak/start elapsed time relative to the stored trip start. All map and replay times are UTC. Nearest reliable observed fix, at most 1 second; no interpolated or extrapolated position.')
        st.write('Sensor episodes and explicit motion-confirmed labels also require valid relevant motion samples within 0.5 seconds of the event time. A trip-wide motion count cannot establish local evidence across recording gaps.')
        st.code(str(record.directory.relative_to(REPO)) if record.directory.is_relative_to(REPO) else str(record.directory),language=None)


if __name__=='__main__': main()
