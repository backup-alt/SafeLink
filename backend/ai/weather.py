"""Bounded prototype weather adapter; forecasts are never official warnings."""
from datetime import datetime, timedelta, timezone
import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen

VARIABLES = {'wind_speed_10m': 'm/s', 'wind_direction_10m': '°',
             'wind_gusts_10m': 'm/s', 'precipitation': 'mm',
             'pressure_msl': 'hPa', 'visibility': 'm'}


def forecast(args):
    start = datetime.fromisoformat(args.start_time.replace('Z', '+00:00')).astimezone(timezone.utc)
    end = datetime.fromisoformat(args.end_time.replace('Z', '+00:00')).astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    if not start < end or end - start > timedelta(hours=48):
        raise ValueError('Weather window must be 0–48 hours')
    if start < now - timedelta(hours=24) or end > now + timedelta(days=7):
        raise ValueError('Outside supported weather horizon')
    params = urlencode({'latitude': args.latitude, 'longitude': args.longitude,
        'hourly': ','.join(VARIABLES), 'wind_speed_unit': 'ms', 'timezone': 'GMT', 'cell_selection': 'sea',
        'start_date': start.date().isoformat(), 'end_date': end.date().isoformat()})
    request = Request('https://api.open-meteo.com/v1/forecast?' + params,
                      headers={'User-Agent': 'SafeLink/0.1 marine-research-prototype'})
    with urlopen(request, timeout=8) as response:
        raw = response.read(256001)
    if len(raw) > 256000:
        raise ValueError('Weather response too large')
    payload = json.loads(raw)
    hourly, units = payload['hourly'], payload['hourly_units']
    if any(units.get(name) != unit for name, unit in VARIABLES.items()):
        raise ValueError('Unexpected weather units')
    rows = []
    for i, value in enumerate(hourly['time']):
        time = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
        if start <= time < end:
            rows.append({'time': time.isoformat(), **{name: hourly[name][i] for name in VARIABLES}})
    if not rows:
        raise ValueError('No forecast frames in requested interval')
    return {'source': 'Open-Meteo', 'source_url': 'https://open-meteo.com/',
        'kind': 'model_forecast', 'retrieved_at': now.isoformat(),
        'model_run': None, 'underlying_model': 'provider best_match; not independently identified',
        'requested_location': {'latitude': args.latitude, 'longitude': args.longitude},
        'sample_location': {'latitude': payload['latitude'], 'longitude': payload['longitude']},
        'units': VARIABLES, 'frames': rows,
        'missing_values': sum(row[name] is None for row in rows for name in VARIABLES),
        'limitations': ['Not an official marine warning or lightning feed',
                         'Sea-selected weather grid may not resolve fine coastal conditions',
                         'No exact model-run timestamp supplied; retrieval time is not issue time'],
        'licence': 'CC BY 4.0 attribution; free hosted endpoint for non-commercial prototype use'}
