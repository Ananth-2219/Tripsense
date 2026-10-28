"""Import-safe extraction from the frozen historical NumPy/pandas mathematics.

Provenance: analysis/two_trip/analyze.py. Original streams and readings are never
modified. No plotting, threshold fitting, interpolation or filesystem output.
"""
import math
import numpy as np
import pandas as pd

EXTRACTION_VERSION='observed-motion-features/1.0.0'
AXES=['x','y','z','rotationAlpha','rotationBeta','rotationGamma']

def describe(values):
    values=np.asarray(values,dtype=float)
    values=values[np.isfinite(values)]
    if not len(values):return {}
    return dict(n=len(values),mean=float(np.mean(values)),median=float(np.median(values)),
        std=float(np.std(values,ddof=0)),minimum=float(np.min(values)),maximum=float(np.max(values)),
        **{f'p{q}':float(np.percentile(values,q)) for q in [75,90,95,99]})

def finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)

def support(times,valid):
    ts=np.asarray(times,dtype=float);left=ts.copy();right=ts.copy();steps=np.diff(ts)
    good=(steps>0)&(steps<=.5)&valid[:-1]&valid[1:]
    right[:-1][good]=(ts[:-1][good]+ts[1:][good])/2
    left[1:][good]=(ts[:-1][good]+ts[1:][good])/2
    return float((right-left).sum())

def extract_features(trip):
    start_ms=int(round(pd.Timestamp(trip['started_at']).timestamp()*1000))
    duration=float(trip['duration_seconds'])
    rows=trip['readings'];motion=[r for r in rows if r.get('type')=='motion'];gps=[r for r in rows if r.get('type')=='location']
    m=pd.DataFrame([{k:(r.get(k) if finite(r.get(k)) else np.nan) for k in ['timestamp']+AXES} for r in motion],columns=['timestamp']+AXES,dtype=float)
    m=m[m.timestamp.notna()].sort_values('timestamp',kind='stable').reset_index(drop=True)
    m['t']=(m.timestamp-start_ms)/1000
    with np.errstate(over='ignore',invalid='ignore',divide='ignore'):
        m['a']=np.sqrt((m[['x','y','z']]**2).sum(axis=1,skipna=False))
        m['gyro']=np.sqrt((m[['rotationAlpha','rotationBeta','rotationGamma']]**2).sum(axis=1,skipna=False))
        dt=m.t.diff();m['jerk']=m.a.diff().div(dt).where((dt>=.05)&(dt<=.5));m['absjerk']=m.jerk.abs()
    valid=np.isfinite(m.a.to_numpy())&np.isfinite(m.gyro.to_numpy())
    observed=support(m.t,valid)
    gaps=[dict(start=float(a),end=float(b),duration=float(b-a)) for a,b in zip(m.t,m.t.iloc[1:]) if b-a>.5]
    warnings=[]
    if not len(m):warnings.append('No valid motion readings recorded.')
    if len(m) and not valid.all():warnings.append('Some motion readings have missing or invalid sensor axes; no values were filled in.')
    if gaps:warnings.append(f'{len(gaps)} motion coverage gap(s); missing time is unobserved.')
    first=float(m.t.iloc[0]) if len(m) else None
    if first is not None and first>.5:warnings.append(f'Motion begins {first:.3f} seconds after recording started.')
    g=pd.DataFrame(gps,columns=['type','timestamp','lat','lon']).drop_duplicates().sort_values('timestamp',kind='stable').reset_index(drop=True)
    gps_info=dict(readings=len(gps),valid_fixes=0,gaps_over_5_seconds=0,rejected_short_edges=0,rejected_jump_edges=0,
                  screened_distance_km=0.0,supported_seconds=0.0,accuracy_recorded=False)
    if len(g):
        valid_gps=g.apply(lambda r:finite(r.timestamp) and finite(r.lat) and finite(r.lon) and -90<=r.lat<=90 and -180<=r.lon<=180,axis=1)
        g=g[valid_gps];gps_info['valid_fixes']=len(g)
        if len(g)>1:
            p1,p2=np.radians(g.lat.to_numpy()[:-1].astype(float)),np.radians(g.lat.to_numpy()[1:].astype(float))
            dp=p2-p1;dl=np.radians(g.lon.to_numpy()[1:].astype(float)-g.lon.to_numpy()[:-1].astype(float))
            h=np.sin(dp/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
            distance=6371008.8*2*np.arcsin(np.sqrt(np.clip(h,0,1)))
            seconds=np.diff(g.timestamp.to_numpy(dtype=float))/1000
            speed=np.divide(distance*3.6,seconds,out=np.full_like(seconds,np.inf),where=seconds>0)
            accepted=(seconds>=.5)&(seconds<=5)&(speed<=160)
            gps_info.update(gaps_over_5_seconds=int((seconds>5).sum()),rejected_short_edges=int((seconds<.5).sum()),
                rejected_jump_edges=int(((seconds>=.5)&(seconds<=5)&(speed>160)).sum()),
                screened_distance_km=float(distance[accepted].sum()/1000),supported_seconds=float(seconds[accepted].sum()))
    if not gps_info['valid_fixes']:warnings.append('No GPS readings recorded.')
    if gps_info['gaps_over_5_seconds']:warnings.append('GPS coverage has gaps; missing route segments were not estimated.')
    if gps_info['rejected_jump_edges']:warnings.append('GPS coordinate jumps detected; speed estimates are uncertain.')
    warnings.append('Phone placement, gravity fallback and vehicle orientation are unverified; this is an experimental phone-motion score.')
    return dict(extraction_version=EXTRACTION_VERSION,acceleration=describe(m.a),absjerk=describe(m.absjerk),
        signedjerk=describe(m.jerk),gyro=describe(m.gyro),
        quality=dict(duration_seconds=duration,motion_readings=len(motion),gps_readings=len(gps),
            valid_motion_readings=int(valid.sum()),invalid_motion_readings=len(motion)-int(valid.sum()),
            observed_motion_seconds=observed,motion_coverage_percent=observed/duration*100 if duration>0 else 0,
            unsupported_motion_seconds=max(0,duration-observed),initial_motion_missing_seconds=first,
            motion_gaps=gaps,gps=gps_info,warnings=warnings))
