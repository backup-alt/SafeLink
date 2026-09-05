import asyncio
from contextlib import suppress
import json
import os
import re
import secrets
from time import monotonic
from urllib.parse import urlparse
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from .agent import Agent
from .openai_client import AIConfig, health
from .schemas import ChatRequest, ActionReceipt, event
from .sessions import SessionStore
from .tools import MarineTools

COOKIE = 'safelink_browser'


def create_router(repository, pfz):
    router = APIRouter(prefix='/api/chat')
    store = SessionStore()
    agent = Agent(MarineTools(repository, pfz))

    def owner(request):
        value = request.cookies.get(COOKIE, '')
        if not re.fullmatch('[a-f0-9]{64}', value):
            raise HTTPException(401, 'Start a new SafeLink conversation.')
        return value

    def check_origin(request):
        origin = request.headers.get('origin')
        if origin and urlparse(origin).netloc != request.headers.get('host') and origin not in {'http://localhost:5173', 'http://127.0.0.1:5173'}:
            raise HTTPException(403, 'Cross-site chat requests are not allowed.')

    @router.get('/health')
    def chat_health():
        return health()

    @router.post('/session')
    async def new_session(request: Request, response: Response):
        check_origin(request)
        token = request.cookies.get(COOKIE, '')
        if not re.fullmatch('[a-f0-9]{64}', token):
            token = secrets.token_hex(32)
        key = store.create(token)
        secure = request.url.scheme == 'https' or request.headers.get('x-forwarded-proto') == 'https' or bool(os.getenv('RAILWAY_PUBLIC_DOMAIN'))
        response.set_cookie(COOKIE, token, httponly=True, secure=secure,
                            samesite='strict', max_age=7200, path='/api/chat')
        response.headers['Cache-Control'] = 'no-store'
        return {'conversation_id': key}

    @router.delete('/session/{key}')
    async def delete_session(key: str, request: Request):
        check_origin(request)
        value = store.get(key, owner(request))
        if value.busy:
            raise HTTPException(409, 'Stop the current reply before clearing the conversation.')
        del store.sessions[key]
        return {'cleared': True}

    @router.get('/sessions')
    async def list_sessions(request: Request, response: Response):
        check_origin(request)
        response.headers['Cache-Control'] = 'no-store'
        token = request.cookies.get(COOKIE, '')
        store.prune()
        return {'conversations': [
            {'conversation_id': key,
             'title': next((m['content'][:80] for m in value.messages if m['role'] == 'user'), 'New conversation'),
             'turns': value.turns, 'busy': value.busy}
            for key, value in sorted(store.sessions.items(), key=lambda pair: pair[1].touched, reverse=True)
            if value.owner == token
        ]}

    @router.post('')
    async def chat(body: ChatRequest, request: Request):
        check_origin(request)
        if not health()['configured']:
            raise HTTPException(503, 'SafeLink chat is not configured. Set GROQ_API_KEY for Groq or OPENAI_API_KEY for OpenAI and check AI_PROVIDER. The map remains available.')
        config = AIConfig.read()
        session = store.begin(body.conversation_id, owner(request), config)

        # Store user message in history
        session.messages.append({
            'role': 'user',
            'content': body.message,
            'timestamp': monotonic()
        })

        async def stream():
            queue = asyncio.Queue(maxsize=64)
            assistant_message = {'role': 'assistant', 'content': '', 'timestamp': monotonic(), 'activities': [], 'sources': []}

            async def produce():
                try:
                    async for item in agent.stream(body, session, config):
                        if item.get('type') == 'text_delta':
                            assistant_message['content'] += item.get('text', '')
                        elif item.get('type') == 'error':
                            assistant_message['error'] = item.get('label', 'Reply unavailable.')
                        elif item.get('type') == 'done':
                            assistant_message['complete'] = True
                        elif item.get('type') == 'tool_result':
                            assistant_message['activities'].append({
                                'id': item['id'], 'label': item['label'], 'source': item.get('source'),
                                'state': 'done' if item.get('success') else 'failed'})
                        elif item.get('type') == 'citation':
                            assistant_message['sources'].append({'url': item['url'], 'title': item['title']})
                        elif item.get('type') in {'web_search_result', 'sources'}:
                            assistant_message['sources'].extend(item.get('sources', []))
                        await queue.put(item)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await queue.put(event('error', label='SafeLink could not finish this reply. Please retry.'))
                await queue.put(None)
            task = asyncio.create_task(produce())
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=10)
                    except TimeoutError:
                        yield ': heartbeat\n\n'
                        continue
                    if item is None:
                        break
                    yield 'data: ' + json.dumps(item, ensure_ascii=False) + '\n\n'
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                session.busy = False
                session.touched = monotonic()
                # Store assistant message in history
                session.messages.append(assistant_message)
                assistant_message['activities'] = assistant_message['activities'][-64:]
                assistant_message['sources'] = list({s['url']: s for s in assistant_message['sources']}.values())[:20]
                session.messages[:] = session.messages[-40:]

        return StreamingResponse(stream(), media_type='text/event-stream',
                                 headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})

    @router.post('/session/{key}/actions/{action_id}')
    async def action_receipt(key: str, action_id: str, body: ActionReceipt, request: Request):
        check_origin(request)
        session = store.get(key, owner(request))
        pending = session.pending_actions.get(action_id)
        if pending is None or pending.done():
            raise HTTPException(404, 'Action expired or unavailable')
        pending.set_result(body.status)
        return {'received': True}

    @router.get('/session/{key}/history')
    async def get_history(key: str, request: Request, response: Response):
        check_origin(request)
        response.headers['Cache-Control'] = 'no-store'
        session = store.get(key, owner(request))
        if session.busy:
            raise HTTPException(409, 'This conversation is still generating a reply.')
        return {'messages': session.messages, 'turns': session.turns}

    # References used by offline tests, never exposed in the API.
    router.agent = agent
    router.store = store
    return router
