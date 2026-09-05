import json
import os
from types import SimpleNamespace as NS
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import Mock, patch
from backend.ai.agent import Agent
from backend.ai.openai_client import AIConfig, health
from backend.ai.sessions import Conversation
from backend.ai.tools import ToolResult
from backend.tests.test_ai import FakeClient, request


def chunk(content=None, calls=None, finish=None):
    return NS(choices=[NS(finish_reason=finish, delta=NS(content=content, tool_calls=calls))])


class ConfigTests(TestCase):
    def test_groq_selection_ignores_old_openai_model(self):
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test', 'OPENAI_MODEL': 'gpt-5.5'}, clear=True):
            config = AIConfig.read()
            self.assertEqual('groq', config.provider)
            self.assertEqual('openai/gpt-oss-120b', config.model)
            self.assertTrue(health()['configured'])
        with patch.dict(os.environ, {'AI_PROVIDER': 'groq', 'OPENAI_API_KEY': 'test'}, clear=True):
            self.assertFalse(health()['configured'])


class GroqTests(IsolatedAsyncioTestCase):
    async def test_fragmented_tool_call_result_and_history(self):
        parts = [NS(index=0, id='call1', function=NS(name='update_map', arguments='{"action":')),
                 NS(index=0, id=None, function=NS(name=None, arguments='"test"}'))]
        client = FakeClient([[chunk(calls=[parts[0]]), chunk(calls=[parts[1]], finish='tool_calls')],
                             [chunk(content='Showing waves.'), chunk(finish='stop')]])
        client.chat = NS(completions=client)
        tools = Mock()
        tools.run.return_value = ToolResult({'accepted': True}, actions=[{'type': 'select_layer', 'layer': 'waves'}])
        session = Conversation('owner')
        with patch.dict(os.environ, {'AI_PROVIDER': 'groq'}, clear=True):
            events = [x async for x in Agent(tools, lambda: client).stream(request(), session, AIConfig.read())]
        self.assertEqual('done', events[-1]['type'])
        tools.run.assert_called_once_with('update_map', '{"action":"test"}')
        self.assertIn('map_action', [x['type'] for x in events])
        self.assertEqual('tool', client.calls[1]['messages'][-1]['role'])
        self.assertEqual(2, len(session.history))
        self.assertTrue(all(x.closed for x in client.streams))
        self.assertNotIn('previous_response_id', client.calls[0])

    async def test_failed_stream_preserves_history(self):
        client = FakeClient([[chunk(content='Partial'), chunk(finish='length')]])
        client.chat = NS(completions=client)
        session = Conversation('owner')
        with patch.dict(os.environ, {'AI_PROVIDER': 'groq'}, clear=True), self.assertLogs('backend.ai.agent'):
            events = [x async for x in Agent(Mock(), lambda: client).stream(request(), session, AIConfig.read())]
        self.assertEqual('error', events[-1]['type'])
        self.assertEqual([], session.history)
