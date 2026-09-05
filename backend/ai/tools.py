from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
import json
import logging
from pathlib import Path
import unicodedata
from .schemas import EmptyArgs, LocationArgs, MapArgs, MarineArgs, PFZArgs, Point, PlanArgs, WeatherArgs
from ..pfz_nearest import nearest_pfz

LOG = logging.getLogger(__name__)
TOOL_MODELS = {
    'get_weather_forecast': (WeatherArgs, 'Checking weather forecast', 'Open-Meteo'),
    'execute_plan': (PlanArgs, 'Running parallel marine checks', 'SafeLink specialists'),
    'get_marine_conditions': (MarineArgs, 'Reading marine conditions', 'Copernicus Marine'),
    'get_nearest_pfz': (Point, 'Finding nearest PFZ', 'INCOIS'),
    'get_pfz_details': (PFZArgs, 'Checking INCOIS PFZ data', 'INCOIS'),
    'resolve_location': (LocationArgs, 'Finding the named location', 'Natural Earth map labels'),
    'get_data_availability': (EmptyArgs, 'Checking available data times', 'Copernicus Marine'),
    'update_map': (MapArgs, 'Updating map', None),
}
DESCRIPTIONS = {
    'get_weather_forecast': 'Get hourly model weather at a coordinate and explicit timezone-aware start/end times, up to 48 hours per call within the next 7 days. Wind/gusts in m/s, precipitation mm, pressure hPa, visibility m. Not official warnings or lightning detections; not tide data. Reports actual returned grid position and missing values.',
    'execute_plan': 'Run 1–4 independent read-only specialist tasks concurrently. Each task has a unique id, tool and arguments_json matching that tool schema. No map actions or nested plans. For dependent work (e.g. conditions at a PFZ), get the PFZ first, then use its returned coordinates in a later call. Returns each result with evidence and gaps; missing safety inputs never mean safe.',
    'get_marine_conditions': 'Read native-grid values for only the requested layers at a coordinate and ISO time (null means now). Returns actual sample times, units, unavailable layers. CHL is an observation, not a forecast.',
    'get_nearest_pfz': 'Compute nearest point on all cached official INCOIS PFZ lines from a coordinate. Returns distance, initial true bearing and PFZ ID; not a safe route.',
    'get_pfz_details': 'Get one verified INCOIS advisory by its PFZ Sno. No guessed coordinates.',
    'resolve_location': 'Find named places in the existing map label gazetteer; may return several candidates or none. Ask user to choose if ambiguous. Coordinates are label positions, not vessel locations.',
    'get_data_availability': 'Get coverage and available time ranges for the five Copernicus layers.',
    'update_map': 'Control the visible map: zoom_in/zoom_out, fly_to/place_marker (coordinates and zoom 2–14), highlight_pfz (verified PFZ ID), select_layer, set_time (ISO), clear_map_highlights. request_location opens an optional location chooser; it does NOT return coordinates or grant permission. Set unused fields to null.',
}


def definitions():
    return [{'type': 'function', 'name': name, 'description': DESCRIPTIONS[name],
             'parameters': model.model_json_schema(), 'strict': True}
            for name, (model, _, _) in TOOL_MODELS.items()]


def normalize(name):
    return ''.join(c for c in unicodedata.normalize('NFKD', name).casefold() if c.isalnum())


@lru_cache(maxsize=1)
def labels():
    root = Path(__file__).resolve().parents[2]
    # Production Docker stores public assets in dist, local source in public.
    path = root / 'dist' / 'indian-ocean-labels.json'
    if not path.exists():
        path = root / 'public' / 'indian-ocean-labels.json'
    return json.loads(path.read_text(encoding='utf-8'))


@dataclass
class ToolResult:
    data: dict
    actions: list[dict] = field(default_factory=list)
    success: bool = True


class MarineTools:
    def __init__(self, repository, pfz_service):
        self.repository, self.pfz = repository, pfz_service

    def feature(self, pfz_id):
        snapshot = self.pfz.get()
        matches = [f for f in snapshot['data']['features'] if str(f['properties'].get('Sno')) == pfz_id]
        if len(matches) != 1:
            raise ValueError('PFZ missing or ambiguous')
        return snapshot, matches[0]

    @staticmethod
    def summary(feature):
        coords = feature['geometry']['coordinates']
        return {'pfz_id': str(feature['properties'].get('Sno', feature['id'])),
                'advisory_date': feature['properties'].get('advisory_date'),
                'representative_point': {'longitude': coords[0][0][0], 'latitude': coords[0][0][1]},
                'source': 'INCOIS', 'kind': 'advisory'}

    def run(self, name, arguments):
        if name not in TOOL_MODELS:
            return ToolResult({'error': 'Unsupported tool'}, success=False)
        try:
            args = TOOL_MODELS[name][0].model_validate_json(arguments)
            if name == 'get_weather_forecast':
                from .weather import forecast
                return ToolResult(forecast(args))
            if name == 'execute_plan':
                from .planning import execute_plan
                return execute_plan(self, args)
            if name == 'get_nearest_pfz':
                snapshot = self.pfz.get()
                result = nearest_pfz(snapshot['data'], args.longitude, args.latitude)
                if result is None:
                    return ToolResult({'error': 'No current PFZ features available'}, success=False)
                return ToolResult({**self.summary(result['feature']), 'nearest_point': result['point'],
                                   'distance_km': result['distance_km'], 'bearing_degrees': result['bearing_degrees'],
                                   'metadata': snapshot['metadata'], 'route': 'Direct spherical distance, not a navigable route'})
            if name == 'get_pfz_details':
                snapshot, feature = self.feature(args.pfz_id)
                return ToolResult({**self.summary(feature), 'metadata': snapshot['metadata']})
            if name == 'resolve_location':
                target = normalize(args.name)
                candidates = [x for x in labels() if normalize(x['name']) == target]
                if not candidates:
                    target = {'thoothukudi': 'tuticorin', 'tuticorin': 'thoothukudi'}.get(target, target)
                    candidates = [x for x in labels() if normalize(x['name']) == target]
                if not candidates:
                    candidates = [x for x in labels() if target in normalize(x['name'])][:5]
                return ToolResult({'matches': [{'name': x['name'], 'latitude': x['lat'], 'longitude': x['lng']} for x in candidates[:5]],
                                   'source': 'Natural Earth map label gazetteer', 'note': 'Label locations, not precise departure points'})
            if name == 'get_data_availability':
                catalog = self.repository.catalog()
                return ToolResult({'region': catalog['region'], 'layers': [
                    {'id': x['id'], 'available': x['available'], 'unit': x['unit'],
                     'first_time': min(x['times']) if x['times'] else None,
                     'last_time': max(x['times']) if x['times'] else None}
                    for x in catalog['layers']]})
            if name == 'get_marine_conditions':
                samples = {}
                for layer in dict.fromkeys(args.layers):
                    try:
                        value = self.repository.point(layer, args.latitude, args.longitude, args.time)
                        sample_time = datetime.fromisoformat(value['time'].replace('Z', '+00:00'))
                        target = datetime.fromisoformat(args.time.replace('Z', '+00:00')) if args.time else datetime.now(timezone.utc)
                        samples[layer] = {**value, 'source': 'Copernicus Marine',
                            'kind': 'observed' if layer == 'chlorophyll' else 'model_forecast_or_analysis',
                            'requested_time_offset_hours': round((sample_time - target).total_seconds() / 3600, 2),
                            'sampling': 'nearest native grid and nearest available time'}
                    except Exception as error:
                        LOG.warning('Marine sample unavailable (%s, %s)', layer, type(error).__name__)
                        samples[layer] = {'available': False, 'source': 'Copernicus Marine', 'reason': 'No usable data at this point/time or source unavailable'}
                return ToolResult({'location': args.model_dump(include={'latitude', 'longitude'}),
                                   'requested_time': args.time, 'samples': samples})
            if name == 'update_map':
                action = args.action().model_dump()
                if action['type'] == 'highlight_pfz':
                    self.feature(action['pfz_id'])  # Reject nonexistent/ambiguous advisory IDs.
                return ToolResult({'accepted': True, 'action': action,
                                   'note': 'Browser action requested; execution is not confirmed. For request_location, wait for the user to confirm and send another message.'}, actions=[action])
        except Exception as error:
            # No argument dump, exception body or upstream response in logs/UI.
            LOG.warning('SafeLink tool failed (%s, %s)', name, type(error).__name__)
            return ToolResult({'error': 'Invalid arguments, unavailable data, or ambiguous PFZ. Ask for clarification or use another supported source.'}, success=False)
        return ToolResult({'error': 'Unsupported tool'}, success=False)
