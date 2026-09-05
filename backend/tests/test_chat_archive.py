import json
import os
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.ai.archive import ChatArchive
from backend.ai.routes import create_router
from backend.ai.sessions import Conversation
from backend.tests.test_ai import FakeClient, complete, text


class ArchiveTests(TestCase):
    def test_public_repository_rejected_before_read_or_write(self):
        with patch.dict(os.environ, {'HF_CHAT_DATASET_REPO': 'test/private', 'HF_CHAT_TOKEN': 'test-token', 'HF_DATASET_REPO': 'test/ocean'}):
            archive = ChatArchive()
            with patch('backend.ai.archive.HfApi') as api, patch.object(archive, '_read') as read:
                api.return_value.repo_info.return_value.private = False
                with self.assertRaises(ValueError): archive.update('a' * 64, 'some-id', Conversation('a' * 64))
                read.assert_not_called()
                api.return_value.upload_file.assert_not_called()

    def test_cookie_not_written_and_merge_preserves_other_chats(self):
        archive = ChatArchive()
        api = Mock()
        secret = 'a' * 64
        with patch.object(archive, 'client', return_value=api), patch.object(archive, '_read', return_value={'existing': {'messages': [], 'turns': 0}}):
            archive.update(secret, 'new', Conversation(secret))
        arguments = api.upload_file.call_args.kwargs
        self.assertNotIn(secret, arguments['path_in_repo'])
        self.assertNotIn(secret.encode(), arguments['path_or_fileobj'])
        self.assertEqual({'existing', 'new'}, set(json.loads(arguments['path_or_fileobj'])['conversations']))


class ArchiveAPITests(TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-test-key', 'AI_PROVIDER': 'openai', 'HF_CHAT_DATASET_REPO': '', 'HF_CHAT_TOKEN': ''})
        self.env.start()
        self.records = {}
        self.router, self.client = self.make_app()

    def tearDown(self): self.env.stop()

    def make_app(self):
        router = create_router(Mock(), Mock())
        router.archive.repo, router.archive.token = 'test/private', 'test-token'
        router.archive.client = Mock()
        router.archive.read = Mock(side_effect=lambda owner: json.loads(json.dumps(self.records.get(owner, {}))))
        def update(owner, key, session=None):
            records = self.records.setdefault(owner, {})
            if session is None: records.pop(key, None)
            else: records[key] = json.loads(json.dumps({'messages': session.messages, 'turns': session.turns}))
        router.archive.update = Mock(side_effect=update)
        router.agent.client_factory = lambda: FakeClient([[text('Saved answer'), complete()]])
        app = FastAPI()
        app.include_router(router)
        return router, TestClient(app)

    def test_opt_in_restart_restore_isolation_and_delete(self):
        key = self.client.post('/api/chat/session').json()['conversation_id']
        payload = {'conversation_id': key, 'message': 'My question'}
        self.client.post('/api/chat', json=payload)
        self.router.archive.update.assert_not_called()
        response = self.client.post('/api/chat/history-storage', json={'enabled': True})
        self.assertEqual(200, response.status_code)
        self.assertIn('Max-Age=31536000', response.headers['set-cookie'])
        self.assertTrue(self.records)
        restarted, client = self.make_app()
        client.cookies.update(self.client.cookies)
        listing = client.get('/api/chat/sessions').json()['conversations']
        self.assertEqual(key, listing[0]['conversation_id'])
        history = client.get(f'/api/chat/session/{key}/history').json()
        self.assertEqual('Saved answer', history['messages'][-1]['content'])
        self.assertTrue(history['archived'])
        _, other = self.make_app()
        other.post('/api/chat/history-storage', json={'enabled': True})
        self.assertEqual([], other.get('/api/chat/sessions').json()['conversations'])
        self.assertEqual(404, other.get(f'/api/chat/session/{key}/history').status_code)
        self.assertEqual(200, client.delete(f'/api/chat/session/{key}').status_code)
        self.assertEqual([], client.get('/api/chat/sessions').json()['conversations'])

    def test_failed_sync_preserves_prior_archive_and_warns(self):
        self.client.post('/api/chat/history-storage', json={'enabled': True})
        key = self.client.post('/api/chat/session').json()['conversation_id']
        payload = {'conversation_id': key, 'message': 'Question'}
        self.client.post('/api/chat', json=payload)
        self.router.archive.update.side_effect = RuntimeError('Do not expose credentials')
        self.client.post('/api/chat', json=payload)
        result = self.client.get(f'/api/chat/session/{key}/history').json()
        self.assertTrue(result['archived'])
        self.assertTrue(result['archive_error'])
        self.assertEqual(502, self.client.delete(f'/api/chat/session/{key}').status_code)
        self.assertIn(key, self.router.store.sessions)
