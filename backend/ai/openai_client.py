from dataclasses import dataclass
import json
import os
import re
from itertools import count
from threading import Lock
from openai import AsyncOpenAI


_groq_cursor = count()
_groq_lock = Lock()


def groq_api_keys():
    """Read server-owned credentials without including secrets in errors."""
    raw = os.getenv('GROQ_API_KEYS', '').strip()
    if not raw:
        key = os.getenv('GROQ_API_KEY', '').strip()
        return [key] if key else []
    try:
        keys = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError('GROQ_API_KEYS must be a JSON array of nonempty strings') from None
    if not isinstance(keys, list) or not keys or any(
        not isinstance(key, str) or not key.strip() or any(c.isspace() for c in key.strip())
        for key in keys
    ):
        raise ValueError('GROQ_API_KEYS must be a JSON array of nonempty strings')
    return list(dict.fromkeys(key.strip() for key in keys))


@dataclass(frozen=True)
class AIConfig:
    model: str
    effort: str
    output_tokens: int
    rounds: int
    rpm: int
    daily: int
    turns: int
    concurrent: int
    provider: str = 'openai'

    @classmethod
    def read(cls):
        def number(name, default, low, high):
            value = int(os.getenv(name, str(default)))
            if not low <= value <= high:
                raise ValueError('Invalid chat limit')
            return value
        provider = os.getenv('AI_PROVIDER', 'groq' if any(os.getenv(name, '').strip()
                            for name in ('GROQ_API_KEYS', 'GROQ_API_KEY')) else 'openai').strip().lower()
        if provider not in {'groq', 'openai'}:
            raise ValueError('Invalid AI provider')
        prefix = 'GROQ' if provider == 'groq' else 'OPENAI'
        if provider == 'groq':
            groq_api_keys()
        effort = os.getenv(prefix + '_REASONING_EFFORT', 'medium')
        if effort not in {'none', 'low', 'medium', 'high', 'xhigh'}:
            raise ValueError('Invalid reasoning effort')
        model = os.getenv(prefix + '_MODEL', 'openai/gpt-oss-120b' if provider == 'groq' else 'gpt-5.5').strip()
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9/._-]{0,79}', model) or model.startswith('sk-'):
            raise ValueError('Invalid model')
        return cls(model, effort, number(prefix + '_MAX_OUTPUT_TOKENS', 1500 if provider == 'groq' else 2500, 256, 8000),
                   number('SAFELINK_CHAT_MAX_TOOL_ROUNDS', 5, 1, 8),
                   number('SAFELINK_CHAT_REQUESTS_PER_MINUTE', 6, 1, 30),
                   number('SAFELINK_CHAT_DAILY_REQUESTS', 100, 1, 10000),
                   number('SAFELINK_CHAT_MAX_TURNS', 20, 1, 50),
                   number('SAFELINK_CHAT_MAX_CONCURRENT', 3, 1, 10), provider)


def health():
    try:
        config = AIConfig.read()
    except (ValueError, TypeError):
        return {'status': 'invalid_configuration', 'configured': False}
    configured = bool(groq_api_keys() if config.provider == 'groq' else os.getenv('OPENAI_API_KEY', '').strip())
    return {'status': 'configured_unverified' if configured else 'missing_api_key',
            'configured': configured, 'operational': None,
            'provider': config.provider, 'model': config.model, 'reasoning_effort': config.effort,
            'note': 'Configuration check only; no paid API request or model-access verification.'}


def create_client(rotate=False):
    # Never forward arbitrary endpoint overrides or browser-supplied credentials.
    groq = AIConfig.read().provider == 'groq'
    if groq:
        keys = groq_api_keys()
        if not keys:
            raise ValueError('Configure GROQ_API_KEYS or GROQ_API_KEY')
        # One key per chat turn, including its tool rounds. Each worker rotates independently.
        with _groq_lock:
            api_key = keys[next(_groq_cursor) % len(keys)]
    else:
        api_key = os.environ['OPENAI_API_KEY']
    return AsyncOpenAI(api_key=api_key,
                       base_url='https://api.groq.com/openai/v1' if groq else 'https://api.openai.com/v1',
                       timeout=60, max_retries=0)
