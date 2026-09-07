from unittest import TestCase
from backend.ai.sources import tool_sources
from backend.ai.tools import ToolResult


class SourceTests(TestCase):
    def test_failed_tools_have_no_successful_source(self):
        self.assertEqual([], tool_sources('get_weather_forecast', ToolResult({}, success=False)))

    def test_plan_only_lists_performed_successful_sources(self):
        result = ToolResult({'tasks': [
            {'tool': 'get_weather_forecast', 'status': 'ok'},
            {'tool': 'get_marine_conditions', 'status': 'unavailable'},
            {'tool': 'get_weather_forecast', 'status': 'ok'}]})
        self.assertEqual(['https://open-meteo.com/'], [s['url'] for s in tool_sources('execute_plan', result)])
