from dataclasses import dataclass
import os
import re
from openai import AsyncOpenAI


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

    @classmethod
    def read(cls):
        def number(name, default, low, high):
            value = int(os.getenv(name, str(default)))
            if not low <= value <= high:
                raise ValueError('Invalid chat limit')
            return value
        effort = os.getenv('OPENAI_REASONING_EFFORT', 'medium')
        if effort not in {'none', 'low', 'medium', 'high', 'xhigh'}:
            raise ValueError('Invalid reasoning effort')
        model = os.getenv('OPENAI_MODEL', 'gpt-5.5').strip()
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', model) or model.startswith('sk-'):
            raise ValueError('Invalid model')
        return cls(model, effort, number('OPENAI_MAX_OUTPUT_TOKENS', 2500, 256, 8000),
                   number('ORCA_CHAT_MAX_TOOL_ROUNDS', 5, 1, 8),
                   number('ORCA_CHAT_REQUESTS_PER_MINUTE', 6, 1, 30),
                   number('ORCA_CHAT_DAILY_REQUESTS', 100, 1, 10000),
                   number('ORCA_CHAT_MAX_TURNS', 20, 1, 50),
                   number('ORCA_CHAT_MAX_CONCURRENT', 3, 1, 10))


def health():
    try:
        config = AIConfig.read()
    except (ValueError, TypeError):
        return {'status': 'invalid_configuration', 'configured': False}
    configured = bool(os.getenv('OPENAI_API_KEY', '').strip())
    return {'status': 'ready' if configured else 'missing_api_key', 'configured': configured,
            'model': config.model, 'reasoning_effort': config.effort,
            'note': 'Configuration check only; no paid API request or model-access verification.'}


def create_client():
    # Never forward arbitrary endpoint overrides or browser-supplied credentials.
    return AsyncOpenAI(api_key=os.environ['OPENAI_API_KEY'], base_url='https://api.openai.com/v1',
                       timeout=60, max_retries=0)
