import asyncio
import json
import os
from types import SimpleNamespace as NS
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import Mock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from backend.ai.agent import Agent, public_error_message
from backend.ai.openai_client import AIConfig
from backend.ai.routes import create_router
from backend.ai.schemas import ChatRequest, MAP_ACTION
from backend.ai.sessions import Conversation
from backend.ai.tools import MarineTools, ToolResult, definitions
from backend.pfz_service import PFZService


def e(kind, **kwargs):
    return NS(type=kind, **kwargs)


def complete(id='response-1', output=None):
    return e('response.completed', response=NS(id=id, output=output or []))


def text(value):
    return e('response.output_text.delta', delta=value, item_id='message-1', content_index=0)


class FakeStream:
    def __init__(self, items):
        self.items, self.closed = items, False

    def __aiter__(self):
        return self.iterate()

    async def iterate(self):
        for item in self.items:
            if isinstance(item, Exception):
                raise item
            yield item

    async def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, batches):
        self.batches, self.calls, self.streams = list(batches), [], []
        self.responses = self

    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        stream = FakeStream(self.batches.pop(0))
        self.streams.append(stream)
        return stream


def request():
    return ChatRequest(conversation_id='12345678-1234-4234-8234-123456789012', message='What about here?')


class AgentTests(IsolatedAsyncioTestCase):
    async def test_normal_text_continuity_no_reasoning(self):
        client = FakeClient([[e('response.reasoning_summary_text.delta', delta='PRIVATE'), text('Hello'), complete()]])
        session = Conversation('one', previous_response_id='old-response')
        result = [x async for x in Agent(Mock(), lambda: client).stream(request(), session, AIConfig.read())]
        self.assertEqual('done', result[-1]['type'])
        self.assertIn({'type': 'text_delta', 'text': 'Hello'}, result)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual('old-response', client.calls[0]['previous_response_id'])
        self.assertEqual('gpt-5.5', client.calls[0]['model'])
        self.assertEqual('medium', client.calls[0]['reasoning']['effort'])
        self.assertEqual('response-1', session.previous_response_id)
        self.assertTrue(client.streams[0].closed)

    async def test_function_result_and_map_action(self):
        call = NS(type='function_call', name='update_map', call_id='call-1', arguments='{}')
        client = FakeClient([[complete('tool-response', [call])], [text('Showing waves.'), complete('answer')]])
        tools = Mock()
        tools.run.return_value = ToolResult({'accepted': True}, actions=[{'type': 'select_layer', 'layer': 'waves'}])
        events = [x async for x in Agent(tools, lambda: client).stream(request(), Conversation('one'), AIConfig.read())]
        self.assertIn('tool_start', [x['type'] for x in events])
        self.assertIn('tool_result', [x['type'] for x in events])
        self.assertIn('map_action', [x['type'] for x in events])
        self.assertEqual('function_call_output', client.calls[1]['input'][0]['type'])
        self.assertEqual('call-1', client.calls[1]['input'][0]['call_id'])
        self.assertEqual('tool-response', client.calls[1]['previous_response_id'])

    async def test_web_search_and_citation_safe_urls(self):
        item = NS(type='web_search_call', id='web1', model_dump=lambda: {'status': 'completed', 'action': {'sources': [
            {'url': 'https://incois.gov.in/', 'title': 'INCOIS'}, {'url': 'javascript:alert(1)'}]}})
        client = FakeClient([[e('response.web_search_call.in_progress', item_id='web1'),
                             e('response.output_item.done', item=item), text('Notice [1]'),
                             e('response.output_text.annotation.added', item_id='message-1', content_index=0,
                               annotation={'type': 'url_citation', 'url': 'https://incois.gov.in/', 'title': 'INCOIS', 'start_index': 7, 'end_index': 10}), complete()]])
        events = [x async for x in Agent(Mock(), lambda: client).stream(request(), Conversation('one'), AIConfig.read())]
        web = next(x for x in events if x['type'] == 'web_search_result')
        self.assertEqual(1, web['source_count'])
        self.assertTrue(any(x['type'] == 'citation' for x in events))
        self.assertNotIn('javascript:', json.dumps(events))
        self.assertEqual(['web_search_call.action.sources'], client.calls[0]['include'])

    async def test_api_failure_does_not_leak_or_commit_state(self):
        client = FakeClient([[RuntimeError('SENSITIVE-TEST upstream body')]])
        session = Conversation('one', previous_response_id='old')
        with self.assertLogs('backend.ai.agent', 'WARNING') as logs:
            events = [x async for x in Agent(Mock(), lambda: client).stream(request(), session, AIConfig.read())]
        self.assertEqual('error', events[-1]['type'])
        self.assertNotIn('SENSITIVE-TEST', json.dumps(events) + str(logs.output))
        self.assertEqual('old', session.previous_response_id)

    async def test_incomplete_response_and_round_limit(self):
        for batches in ([[text('Partial'), e('response.incomplete')]],
                        [[complete('tool', [NS(type='function_call', name='get_nearest_pfz', arguments='{}', call_id='x')])]]):
            client = FakeClient(batches)
            with patch.dict(os.environ, {'SAFELINK_CHAT_MAX_TOOL_ROUNDS': '1'}), self.assertLogs('backend.ai.agent', 'WARNING'):
                events = [x async for x in Agent(Mock(), lambda: client).stream(request(), Conversation('one'), AIConfig.read())]
            self.assertEqual('error', events[-1]['type'])

    def test_public_error_message_classifies_status_without_leaking_body(self):
        error = RuntimeError('SENSITIVE upstream response')
        error.status_code = 429
        message = public_error_message(error)
        self.assertIn('API credits', message)
        self.assertNotIn('SENSITIVE', message)

    async def test_cancellation_closes_upstream(self):
        entered = asyncio.Event()
        class Waiting(FakeStream):
            async def iterate(self):
                entered.set()
                await asyncio.Event().wait()
                yield text('never')
        client = FakeClient([])
        stream = Waiting([])
        async def create(**kwargs): return stream
        client.create = create
        async def consume():
            return [x async for x in Agent(Mock(), lambda: client).stream(request(), Conversation('one'), AIConfig.read())]
        task = asyncio.create_task(consume())
        await entered.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(stream.closed)


class ToolTests(TestCase):
    def setUp(self):
        self.repo, self.pfz = Mock(), Mock()
        self.tools = MarineTools(self.repo, self.pfz)

    def test_malformed_arguments_and_allowlist(self):
        with self.assertLogs('backend.ai.tools', 'WARNING'):
            self.assertFalse(self.tools.run('get_nearest_pfz', '{bad').success)
            self.assertFalse(self.tools.run('get_nearest_pfz', '{"latitude":91,"longitude":0}').success)
        self.assertFalse(self.tools.run('run_javascript', '{}').success)
        self.repo.point.assert_not_called()
        with self.assertRaises(ValidationError):
            MAP_ACTION.validate_python({'type': 'fly_to', 'latitude': 10, 'longitude': 80, 'zoom': 8, 'javascript': 'evil'})

    def test_marine_requested_layers_only_and_missing_sample(self):
        self.repo.point.side_effect = [{'value': 1.34, 'unit': 'mg/m³', 'time': '2026-09-02T00:00:00Z'}, ValueError('secret detail')]
        with self.assertLogs('backend.ai.tools', 'WARNING'):
            result = self.tools.run('get_marine_conditions', json.dumps({'latitude': 11, 'longitude': 81, 'time': '2026-09-04T00:00:00Z', 'layers': ['chlorophyll', 'waves']}))
        self.assertEqual(2, self.repo.point.call_count)
        chl = result.data['samples']['chlorophyll']
        self.assertEqual('observed', chl['kind'])
        self.assertEqual(-48, chl['requested_time_offset_hours'])
        self.assertFalse(result.data['samples']['waves']['available'])
        self.assertNotIn('secret detail', json.dumps(result.data))

    def test_nearest_compact_no_full_geometry(self):
        self.pfz.get.return_value = {'metadata': {'stale': True}, 'data': {'features': [
            {'id': 1, 'properties': {'Sno': '097', 'advisory_date': '2026-09-04'},
             'geometry': {'coordinates': [[[80, 10], [82, 10]]]}}]}}
        result = self.tools.run('get_nearest_pfz', '{"latitude":11,"longitude":81}')
        self.assertTrue(result.success)
        self.assertEqual('097', result.data['pfz_id'])
        self.assertNotIn('geometry', result.data)
        self.assertTrue(result.data['metadata']['stale'])

    def test_resolve_named_place_without_guessing(self):
        with patch('backend.ai.tools.labels', return_value=[{'name': 'Tuticorin', 'lat': 8.8, 'lng': 78.1}]):
            found = self.tools.run('resolve_location', '{"name":"Thoothukudi"}')
            missing = self.tools.run('resolve_location', '{"name":"NotARealTown"}')
        self.assertEqual('Tuticorin', found.data['matches'][0]['name'])
        self.assertEqual([], missing.data['matches'])

    def test_strict_function_schemas(self):
        for tool in definitions():
            schema = tool['parameters']
            self.assertFalse(schema['additionalProperties'])
            self.assertEqual(set(schema.get('properties', {})), set(schema.get('required', [])))


class ChatAPITests(TestCase):
    def setUp(self):
        self.router = create_router(Mock(), PFZService())
        self.app = FastAPI(); self.app.include_router(self.router)
        self.client = TestClient(self.app)
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-test-key'})
        self.env.start()

    def tearDown(self): self.env.stop()

    def session(self, client=None):
        return (client or self.client).post('/api/chat/session').json()['conversation_id']

    def test_missing_key_non_paid_health(self):
        key = self.session()
        health = self.client.get('/api/chat/health').json()
        self.assertEqual('configured_unverified', health['status'])
        self.assertIsNone(health['operational'])
        with patch.dict(os.environ, {'OPENAI_API_KEY': ''}):
            self.assertFalse(self.client.get('/api/chat/health').json()['configured'])
            self.assertEqual(503, self.client.post('/api/chat', json={'conversation_id': key, 'message': 'Hello'}).status_code)

    def test_stream_and_cookie_security(self):
        response = self.client.post('/api/chat/session')
        self.assertIn('HttpOnly', response.headers['set-cookie'])
        self.assertIn('SameSite=strict', response.headers['set-cookie'])
        key = response.json()['conversation_id']
        self.router.agent.client_factory = lambda: FakeClient([[text('Hello'), complete()]])
        response = self.client.post('/api/chat', json={'conversation_id': key, 'message': 'Hello'})
        self.assertEqual(200, response.status_code)
        self.assertIn('text/event-stream', response.headers['content-type'])
        self.assertIn('text_delta', response.text)
        self.assertIn('"type": "done"', response.text)
        self.assertNotIn('offline-test-key', response.text)
        self.assertFalse(self.router.store.sessions[key].busy)
        forwarded = TestClient(self.app).post('/api/chat/session', headers={'x-forwarded-proto': 'https'})
        self.assertIn('Secure', forwarded.headers['set-cookie'])

    def test_session_isolation_clear_and_invalid_request(self):
        key = self.session()
        other = TestClient(self.app); self.session(other)
        payload = {'conversation_id': key, 'message': 'Hello'}
        self.assertEqual(404, other.post('/api/chat', json=payload).status_code)
        self.assertEqual(404, other.delete('/api/chat/session/' + key).status_code)
        self.assertEqual(422, self.client.post('/api/chat', json={**payload, 'map_context': {'javascript': 'evil'}}).status_code)
        self.assertEqual(200, self.client.delete('/api/chat/session/' + key).status_code)
        self.assertEqual(404, self.client.post('/api/chat', json=payload).status_code)

    def test_csrf_and_rate_limits(self):
        self.assertEqual(403, self.client.post('/api/chat/session', headers={'Origin': 'https://evil.example'}).status_code)
        key = self.session()
        self.router.store.sessions[key].busy = True
        self.assertEqual(409, self.client.post('/api/chat', json={'conversation_id': key, 'message': 'Hi'}).status_code)
        self.router.store.sessions[key].busy = False
        self.router.store.sessions[key].turns = 20
        self.assertEqual(429, self.client.post('/api/chat', json={'conversation_id': key, 'message': 'Hi'}).status_code)

    def test_map_health_unchanged_when_ai_missing(self):
        from backend.app import app
        with patch.dict(os.environ, {'OPENAI_API_KEY': ''}):
            response = TestClient(app).get('/api/health')
        self.assertEqual({'status': 'ok'}, response.json())
