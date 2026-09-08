import json
import os
from types import SimpleNamespace as NS
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import Mock, patch
from backend.ai.agent import Agent
from backend.ai.openai_client import AIConfig, health, groq_api_keys, create_client
from backend.ai.sessions import Conversation
from backend.ai.tools import ToolResult
from backend.tests.test_ai import FakeClient, request


def chunk(content=None, calls=None, finish=None):
    return NS(choices=[NS(finish_reason=finish, delta=NS(content=content, tool_calls=calls))])


class ConfigTests(TestCase):
    def test_key_list_precedence_deduplication_and_rotation(self):
        with patch.dict(os.environ, {'GROQ_API_KEYS': '[" first ", "second", "first"]',
                                     'GROQ_API_KEY': 'legacy'}, clear=True), \
             patch('backend.ai.openai_client.AsyncOpenAI') as client:
            self.assertEqual(['first', 'second'], groq_api_keys())
            self.assertEqual('groq', AIConfig.read().provider)
            self.assertTrue(health()['configured'])
            for _ in range(4):
                create_client()
            selected = [call.kwargs['api_key'] for call in client.call_args_list]
            self.assertEqual(selected[:2], selected[2:])
            self.assertEqual({'first', 'second'}, set(selected[:2]))
            self.assertNotIn('first', json.dumps(health()))

    def test_invalid_key_lists_fail_without_exposing_credentials(self):
        for raw in ['secret-key', '[]', '{}', '"secret-key"', '[null]', '[1]', '[""]', '["a b"]']:
            with self.subTest(raw=raw), patch.dict(os.environ, {'GROQ_API_KEYS': raw}, clear=True):
                self.assertEqual('invalid_configuration', health()['status'])
                with self.assertRaises(ValueError) as caught:
                    create_client()
                self.assertNotIn('secret-key', str(caught.exception))

    def test_blank_list_falls_back_and_openai_ignores_list(self):
        with patch.dict(os.environ, {'GROQ_API_KEYS': ' ', 'GROQ_API_KEY': 'legacy'}, clear=True), \
             patch('backend.ai.openai_client.AsyncOpenAI') as client:
            create_client()
            self.assertEqual('legacy', client.call_args.kwargs['api_key'])
        with patch.dict(os.environ, {'AI_PROVIDER': 'openai', 'GROQ_API_KEYS': 'invalid',
                                     'OPENAI_API_KEY': 'openai-test'}, clear=True), \
             patch('backend.ai.openai_client.AsyncOpenAI') as client:
            create_client()
            self.assertEqual('openai-test', client.call_args.kwargs['api_key'])
            self.assertTrue(health()['configured'])

    def test_groq_selection_ignores_old_openai_model(self):
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test', 'OPENAI_MODEL': 'gpt-5.5'}, clear=True):
            config = AIConfig.read()
            self.assertEqual('groq', config.provider)
            self.assertEqual('openai/gpt-oss-120b', config.model)
            self.assertTrue(health()['configured'])
        with patch.dict(os.environ, {'AI_PROVIDER': 'groq', 'OPENAI_API_KEY': 'test'}, clear=True):
            self.assertFalse(health()['configured'])


class GroqTests(IsolatedAsyncioTestCase):
    async def test_rate_limited_key_retries_on_next_key(self):
        class FailingCompletions:
            async def create(self, **kwargs):
                error = RuntimeError('rate limited')
                error.status_code = 429
                raise error

        class Context:
            def __init__(self, completions):
                self.chat = NS(completions=completions)
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass

        good = FakeClient([[chunk(content='Recovered.'), chunk(finish='stop')]])
        good.chat = NS(completions=good)
        contexts = iter([Context(FailingCompletions()), good])
        factory = lambda **kwargs: next(contexts)
        session = Conversation('owner')
        with patch.dict(os.environ, {'AI_PROVIDER': 'groq', 'GROQ_API_KEYS': '["one", "two"]'}, clear=True):
            events = [x async for x in Agent(Mock(), factory).stream(request(), session, AIConfig.read())]
        self.assertEqual('done', events[-1]['type'])
        self.assertEqual('Recovered.', next(x['text'] for x in events if x['type'] == 'text_delta'))

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
            events = []
            async for item in Agent(tools, lambda: client).stream(request(), session, AIConfig.read()):
                events.append(item)
                if item['type'] == 'map_action':
                    session.pending_actions[item['id']].set_result('accepted')
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
