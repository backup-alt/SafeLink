"""Opt-in, single-worker private Hub archive. Never stores browser credentials."""
from hashlib import sha256
import json
import os
from pathlib import Path
from threading import Lock
from time import time
from uuid import UUID
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import RemoteEntryNotFoundError


class ChatArchive:
    def __init__(self):
        self.repo = os.getenv('HF_CHAT_DATASET_REPO', '').strip()
        self.token = os.getenv('HF_CHAT_TOKEN') or os.getenv('HF_TOKEN')
        self.lock = Lock()

    @property
    def configured(self):
        return bool(self.repo and self.token)

    def client(self):
        if not self.configured or self.repo == os.getenv('HF_DATASET_REPO'):
            raise ValueError('A separate private chat repository is required')
        api = HfApi(token=self.token)
        if api.repo_info(self.repo, repo_type='dataset', timeout=10).private is not True:
            raise ValueError('Public repositories cannot store chat history')
        return api

    def path(self, owner):
        return 'private-chats/' + sha256(owner.encode()).hexdigest() + '.json'

    def _read(self, owner):
        try:
            path = hf_hub_download(self.repo, self.path(owner), repo_type='dataset', token=self.token)
        except RemoteEntryNotFoundError:
            return {}
        if Path(path).stat().st_size > 2_000_000:
            raise ValueError('Archive exceeds size limit')
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        if data.get('version') != 1 or not isinstance(data.get('conversations'), dict) or len(data['conversations']) > 8:
            raise ValueError('Invalid archive')
        for key, value in data['conversations'].items():
            UUID(key)
            if not isinstance(value.get('messages'), list) or len(value['messages']) > 40:
                raise ValueError('Invalid transcript')
            if not isinstance(value.get('turns'), int) or not 0 <= value['turns'] <= 10000:
                raise ValueError('Invalid turn count')
            for message in value['messages']:
                if message.get('role') not in {'user', 'assistant'} or not isinstance(message.get('content'), str):
                    raise ValueError('Invalid message')
        return data['conversations']

    def read(self, owner):
        with self.lock:
            self.client()
            return self._read(owner)

    def update(self, owner, key, session=None):
        with self.lock:
            api = self.client()
            records = self._read(owner)
            if session is None:
                records.pop(key, None)
            else:
                records[key] = {'messages': session.messages[-40:], 'turns': session.turns, 'saved_at': time()}
            if len(records) > 8:
                raise ValueError('Archive conversation limit reached')
            payload = json.dumps({'version': 1, 'conversations': records}, ensure_ascii=False).encode()
            if len(payload) > 2_000_000:
                raise ValueError('Archive exceeds size limit')
            api.upload_file(path_or_fileobj=payload, path_in_repo=self.path(owner), repo_id=self.repo,
                            repo_type='dataset', commit_message='Update private chat archive')
