from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from threading import Barrier, Event
from unittest import TestCase
from unittest.mock import Mock, patch
from backend.ai.schemas import PlanArgs, WeatherArgs
from backend.ai.planning import execute_plan
from backend.ai.tools import MarineTools, ToolResult, execution_cost
from backend.ai.weather import forecast, VARIABLES


class PlanningTests(TestCase):
    def test_children_count_against_tool_budget(self):
        arguments = json.dumps({'tasks': [{'id': 'one', 'tool': 'get_data_availability', 'arguments_json': '{}'}]})
        self.assertEqual(2, execution_cost('execute_plan', arguments))
        self.assertEqual(1, execution_cost('get_data_availability', '{}'))

    def test_dependency_cycle_and_missing_id_rejected(self):
        for dependencies in [('second', 'first'), ('missing', 'first')]:
            with self.assertRaises(ValueError):
                PlanArgs.model_validate({'tasks': [
                    {'id': 'first', 'tool': 'get_data_availability', 'arguments_json': '{}', 'depends_on': [dependencies[0]]},
                    {'id': 'second', 'tool': 'get_data_availability', 'arguments_json': '{}', 'depends_on': [dependencies[1]]}]})

    def test_dependency_order_and_skipped_failure(self):
        for success in (True, False):
            calls = []
            def run(name, arguments):
                calls.append(name)
                return ToolResult({}, success=success)
            plan = PlanArgs.model_validate({'tasks': [
                {'id': 'second', 'tool': 'resolve_location', 'arguments_json': '{"name":"Chennai"}', 'depends_on': ['first']},
                {'id': 'first', 'tool': 'get_data_availability', 'arguments_json': '{}'}]})
            result = execute_plan(Mock(run=run), plan)
            self.assertEqual('get_data_availability', calls[0])
            self.assertEqual(2 if success else 1, len(calls))
            self.assertEqual('ok' if success else 'skipped', result.data['tasks'][0]['status'])

    def test_timeout_returns_without_waiting_for_blocked_tool(self):
        release, finished = Event(), Event()
        def run(*args):
            release.wait(2)
            finished.set()
            return ToolResult({'value': 1})
        plan = PlanArgs.model_validate({'tasks': [{'id': 'slow', 'tool': 'get_data_availability', 'arguments_json': '{}'}]})
        try:
            with patch('backend.ai.planning.PLAN_TIMEOUT', .05):
                result = execute_plan(Mock(run=run), plan)
            self.assertFalse(finished.is_set())
            self.assertEqual('timeout', result.data['tasks'][0]['status'])
            self.assertFalse(result.success)
        finally:
            release.set()
            finished.wait(2)

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
