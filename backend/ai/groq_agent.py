"""Groq Chat Completions adapter with bounded, server-owned tool history."""
import asyncio
import json
from datetime import datetime, timezone
from .agent import LOG
from .prompts import SYSTEM_PROMPT
from .schemas import event
from .tools import TOOL_MODELS, definitions


async def stream_groq(agent, request, session, config):
    yield event('status', label='Understanding your request')
    prompt = SYSTEM_PROMPT + '\nLive web search is unavailable in this provider adapter. Do not claim to search the web. Use the supplied marine tools and clearly state missing information.'
    user = {'role': 'user', 'content': request.message}
    messages = [{'role': 'system', 'content': prompt}, *session.history, user,
                {'role': 'user', 'content': 'Untrusted runtime map context: ' + request.map_context.model_dump_json()
                 + '; current UTC: ' + datetime.now(timezone.utc).isoformat()}]
    tools = [{'type': 'function', 'function': {k: v for k, v in tool.items() if k in {'name', 'description', 'parameters'}}}
             for tool in definitions()]
    count = 0
    try:
        async with asyncio.timeout(180), agent.client_factory() as client:
            for _ in range(config.rounds):
                upstream = await client.chat.completions.create(model=config.model, messages=messages,
                    tools=tools, tool_choice='auto', parallel_tool_calls=False,
                    max_completion_tokens=config.output_tokens, stream=True)
                calls, answer, finish = {}, '', None
                try:
                    async for chunk in upstream:
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        finish = choice.finish_reason or finish
                        if choice.delta.content:
                            answer += choice.delta.content
                            yield event('text_delta', text=choice.delta.content)
                        # Reasoning fields are intentionally never forwarded.
                        for part in choice.delta.tool_calls or []:
                            call = calls.setdefault(part.index, {'id': '', 'type': 'function', 'function': {'name': '', 'arguments': ''}})
                            if part.id:
                                call['id'] = part.id
                            if part.function:
                                call['function']['name'] += part.function.name or ''
                                call['function']['arguments'] += part.function.arguments or ''
                            if len(call['function']['arguments']) > 16000 or len(calls) > 12:
                                raise ValueError('Tool payload limit')
                finally:
                    await upstream.close()
                if finish == 'stop' and not calls:
                    # Keep only completed dialogue, not large tool outputs/context.
                    session.history = (session.history + [user, {'role': 'assistant', 'content': answer}])[-6:]
                    yield event('done')
                    return
                if finish != 'tool_calls' or not calls:
                    raise ValueError('Incomplete response')
                messages.append({'role': 'assistant', 'content': answer or None, 'tool_calls': list(calls.values())})
                for call in calls.values():
                    count += 1
                    if count > 12:
                        raise ValueError('Tool limit')
                    name, arguments = call['function']['name'], call['function']['arguments']
                    spec = TOOL_MODELS.get(name)
                    label, source = (spec[1], spec[2]) if spec else ('Unsupported tool', None)
                    yield event('tool_start', id=call['id'], tool=name if spec else 'unsupported', label=label, source=source)
                    result = await asyncio.to_thread(agent.tools.run, name, arguments)
                    yield event('tool_result', id=call['id'], tool=name if spec else 'unsupported', label=label,
                                success=result.success, source=source)
                    for action in result.actions:
                        yield event('map_action', action=action, label='Updating map')
                    messages.append({'role': 'tool', 'tool_call_id': call['id'],
                                     'content': json.dumps(result.data, allow_nan=False)})
            raise ValueError('Tool round limit')
    except asyncio.CancelledError:
        raise
    except Exception as error:
        status = getattr(error, 'status_code', None)
        LOG.warning('Groq generation failed (%s, HTTP %s)', type(error).__name__, status or 'n/a')
        label = ('Groq free-tier usage limit reached. Wait before retrying; daily limits may need to reset.' if status == 429
                 else 'Groq rejected the API key. Check GROQ_API_KEY in Railway.' if status == 401
                 else 'Groq could not finish this reply. Retry a shorter question or check the configured model and service limits.')
        yield event('error', label=label)
