"""SELECT-only MCP handoff. The dashboard never obtains database credentials.

Print a scoped query for the existing supabase_trips_readonly.execute_sql tool,
then import its returned JSON to verify the existing analyzed sensor exports.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, localcontext
import json
from pathlib import Path
import re

from .data import discover_trips, read_json, timestamp_ms

REPO = Path(__file__).resolve().parents[1]


def verification_query(trips):
    if not trips: raise ValueError('No successfully analyzed trips')
    # IDs come only from discover_trips, which canonicalizes UUIDs.
    from uuid import UUID
    ids = ','.join("'" + str(UUID(t.id)) + "'::uuid" for t in trips)
    return f"""SELECT t.id, to_jsonb(t)-'readings' AS metadata,
       jsonb_array_length(t.readings) AS reading_count,
       (SELECT jsonb_object_agg(field,total) FROM
         (SELECT k AS field, sum((v#>>'{{}}')::numeric)::text AS total
          FROM jsonb_array_elements(t.readings) e
          CROSS JOIN LATERAL jsonb_each(e) f(k,v)
          WHERE jsonb_typeof(v)='number' GROUP BY k) sums) AS numeric_sums
FROM public.trips t WHERE t.id IN ({ids}) ORDER BY t.id;"""


def parse_mcp_response(payload):
    if isinstance(payload, list): return payload
    if not isinstance(payload,dict): raise ValueError('Expected MCP JSON object or row array')
    if 'content' in payload:
        for item in payload['content']:
            if item.get('type') == 'text':
                try: return parse_mcp_response(json.loads(item['text']))
                except (ValueError, KeyError): continue
    if isinstance(payload.get('result'), str):
        match = re.search(r'\n<untrusted-data-[^>]+>\s*(\[[\s\S]*?\])\s*</untrusted-data-',payload['result'])
        if match: return json.loads(match.group(1))
    raise ValueError('Expected MCP SQL JSON rows; response is treated only as data')


def verify_exports(trips, rows):
    by_id = {r['id']: r for r in rows}
    verified = {}
    for trip in trips:
        record = by_id.get(trip.id)
        raw = read_json(trip.raw_path)
        if not record or record['reading_count'] != len(raw['readings']):
            raise ValueError(f'{trip.id}: missing database row or different record count')
        if set(record['metadata']) != set(raw)-{'readings'}:
            raise ValueError(f'{trip.id}: incomplete or changed database metadata fields')
        for key, value in record['metadata'].items():
            same = (timestamp_ms(raw.get(key)) == timestamp_ms(value) if key in ['started_at','ended_at','created_at']
                    else raw.get(key) == value)
            if not same: raise ValueError(f'{trip.id}: database metadata changed ({key})')
        with localcontext() as context:
            context.prec = 60
            sums = {}
            for reading in raw['readings']:
                for key, value in reading.items():
                    if isinstance(value,(int,float)) and not isinstance(value,bool):
                        sums[key] = sums.get(key,Decimal(0)) + Decimal(str(value))
            if set(sums) != set(record['numeric_sums']):
                raise ValueError(f'{trip.id}: database numeric fields changed')
            if any(abs(value-Decimal(record['numeric_sums'][key])) >= Decimal('1e-10') for key,value in sums.items()):
                raise ValueError(f'{trip.id}: database checksums changed; re-export and re-analyze')
        verified[trip.id] = dict(raw_sha256=trip.raw_digest,reading_count=record['reading_count'],numeric_sums=record['numeric_sums'])
    return dict(server='supabase_trips_readonly',table='public.trips',mode='SELECT only',
                checked_at=datetime.now(timezone.utc).isoformat(),trips=verified)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--response',type=Path,help='Saved execute_sql response or JSON row array')
    parser.add_argument('--analysis-root',type=Path,default=REPO/'analysis')
    parser.add_argument('--cache-dir',type=Path,default=REPO/'.trip_maps')
    args = parser.parse_args()
    trips,_ = discover_trips(args.analysis_root)
    if args.response:
        manifest = verify_exports(trips,parse_mcp_response(read_json(args.response)))
        args.cache_dir.mkdir(parents=True,exist_ok=True)
        (args.cache_dir/'source_manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
        print(f'Verified {len(trips)} analyzed exports; no database writes')
    else: print(verification_query(trips))


if __name__ == '__main__': main()
