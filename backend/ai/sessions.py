"""Bounded single-worker MVP state; IDs are bound to an HttpOnly browser cookie."""
from collections import deque
from dataclasses import dataclass, field
from time import monotonic
from uuid import uuid4
from fastapi import HTTPException


@dataclass
class Conversation:
    owner: str
    previous_response_id: str | None = None
    touched: float = field(default_factory=monotonic)
    turns: int = 0
    busy: bool = False


class SessionStore:
    def __init__(self):
        self.sessions: dict[str, Conversation] = {}
        self.usage = deque()

    def prune(self):
        now = monotonic()
        for key, value in list(self.sessions.items()):
            if not value.busy and now - value.touched > 7200:
                del self.sessions[key]
        while self.usage and now - self.usage[0][0] > 86400:
            self.usage.popleft()

    def create(self, owner):
        self.prune()
        if len(self.sessions) >= 200 or sum(s.owner == owner for s in self.sessions.values()) >= 8:
            raise HTTPException(429, 'Too many conversations. Clear a conversation or try later.')
        key = str(uuid4())
        self.sessions[key] = Conversation(owner)
        return key

    def get(self, key, owner):
        self.prune()
        value = self.sessions.get(str(key))
        if value is None or value.owner != owner:
            raise HTTPException(404, 'Conversation expired or unavailable. Start a new conversation.')
        return value

    def begin(self, key, owner, config):
        value = self.get(key, owner)
        if value.busy:
            raise HTTPException(409, 'This conversation is already generating a reply.')
        if value.turns >= config.turns:
            raise HTTPException(429, 'Conversation limit reached. Start a new conversation.')
        if len(self.usage) >= config.daily:
            raise HTTPException(429, 'The daily SafeLink chat limit has been reached. The map is still available.')
        if sum(x.busy for x in self.sessions.values()) >= config.concurrent:
            raise HTTPException(429, 'SafeLink AI is busy. Please try again shortly.')
        if sum(user == owner and monotonic() - stamp < 60 for stamp, user in self.usage) >= config.rpm:
            raise HTTPException(429, 'Please wait a minute before sending more messages.')
        self.usage.append((monotonic(), owner))
        value.busy = True
        value.touched = monotonic()
        value.turns += 1
        return value
