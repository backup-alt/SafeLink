from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from threading import Barrier
from unittest import TestCase
from unittest.mock import Mock, patch
from backend.ai.schemas import PlanArgs, WeatherArgs
from backend.ai.planning import execute_plan
from backend.ai.tools import MarineTools, ToolResult
from backend.ai.weather import forecast, VARIABLES


class PlanningTests(TestCase):
    def test_parallel_results_and_partial_safety(self):
        barrier = Barrier(2, timeout=2)
        def run(name, args):
            barrier.wait()
            return ToolResult({'value': 1}, success=name != 'resolve_location')
        tools = Mock(run=run)
        plan = PlanArgs.model_validate({'tasks': [
            {'id': 'catalog', 'tool': 'get_data_availability', 'arguments_json': '{}'},
            {'id': 'place', 'tool': 'resolve_location', 'arguments_json': '{"name":"Chennai"}'}]})
        result = execute_plan(tools, plan)
        self.assertEqual('partial', result.data['plan_status'])
        self.assertEqual('UNKNOWN', result.data['safety_assessment']['status'])
        self.assertTrue(all(row['evidence']['id'].startswith('ev-') for row in result.data['tasks']))

    def test_validation_before_execution(self):
        tools = Mock()
        plan = PlanArgs.model_validate({'tasks': [
            {'id': 'catalog', 'tool': 'get_data_availability', 'arguments_json': '{}'},
            {'id': 'bad', 'tool': 'get_nearest_pfz', 'arguments_json': '{"latitude":999,"longitude":0}'}]})
        with self.assertRaises(ValueError): execute_plan(tools, plan)
        tools.run.assert_not_called()


class WeatherTests(TestCase):
    def test_units_time_window_and_missing(self):
        start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        args = WeatherArgs(latitude=12, longitude=80, start_time=start.isoformat(), end_time=(start+timedelta(hours=2)).isoformat())
        payload = {'latitude': 12.1, 'longitude': 80.1, 'hourly_units': VARIABLES,
            'hourly': {'time': [(start+timedelta(hours=i)).strftime('%Y-%m-%dT%H:%M') for i in range(3)],
                       **{name: [1, None, 3] for name in VARIABLES}}}
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(payload).encode()
        with patch('backend.ai.weather.urlopen', return_value=response):
            result = forecast(args)
        self.assertEqual(2, len(result['frames']))
        self.assertEqual(6, result['missing_values'])
        self.assertEqual('model_forecast', result['kind'])
        self.assertIsNone(result['model_run'])

    def test_long_interval_rejected_without_network(self):
        start = datetime.now(timezone.utc)
        args = WeatherArgs(latitude=12, longitude=80, start_time=start.isoformat(), end_time=(start+timedelta(days=3)).isoformat())
        with patch('backend.ai.weather.urlopen') as fetch:
            with self.assertRaises(ValueError): forecast(args)
            fetch.assert_not_called()
