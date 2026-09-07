"""Validated bounded read-only plans. No model-generated executable code."""
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
import hashlib
import json
from threading import BoundedSemaphore
from time import monotonic
from .tools import TOOL_MODELS, ToolResult

POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix='marine-specialist')
SLOTS = BoundedSemaphore(4)
PLAN_TIMEOUT = 20


def execute_plan(tools, plan):
    # Validate every child before executing any. Plans cannot recursively expand.
    for task in plan.tasks:
        TOOL_MODELS[task.tool][0].model_validate_json(task.arguments_json)

    def unavailable(task, status, reason):
        return {'task_id': task.id, 'tool': task.tool, 'status': status,
                'data': {'error': reason}, 'evidence': None}

    def execute(task):
        try:
            result = tools.run(task.tool, task.arguments_json)
            data = result.data
            status = 'ok' if result.success else 'unavailable'
            if result.success and isinstance(data.get('samples'), dict) and any(
                    sample.get('available') is False for sample in data['samples'].values()):
                status = 'partial'
            source = TOOL_MODELS[task.tool][2]
            timestamp = datetime.now(timezone.utc).isoformat()
            digest = hashlib.sha256(json.dumps({'tool': task.tool, 'input': task.arguments_json,
                'data': data}, sort_keys=True, allow_nan=False).encode()).hexdigest()
            return {'task_id': task.id, 'tool': task.tool, 'status': status, 'data': data,
                    'evidence': {'id': 'ev-' + digest[:24], 'source': source,
                                 'retrieved_at': timestamp, 'content_sha256': digest,
                                 'note': 'Retrieval time is not observation time; use timestamps inside the result.'}}
        except Exception:
            return unavailable(task, 'unavailable', 'Specialist unavailable')
        finally:
            SLOTS.release()

    pending = {task.id: task for task in plan.tasks}
    running, completed = {}, {}
    deadline = monotonic() + PLAN_TIMEOUT
    while pending or running:
        if monotonic() >= deadline:
            for task in [*pending.values(), *running.values()]:
                completed[task.id] = unavailable(task, 'timeout', 'Plan deadline exceeded; no result used')
            # Synchronous calls cannot be killed. Keep their slots occupied until
            # they return and discard late results; never spawn replacement pools.
            break
        for key, task in list(pending.items()):
            if not all(dep in completed for dep in task.depends_on):
                continue
            if any(completed[dep]['status'] != 'ok' for dep in task.depends_on):
                completed[key] = unavailable(task, 'skipped', 'A required dependency was incomplete')
            elif SLOTS.acquire(blocking=False):
                try:
                    running[POOL.submit(execute, task)] = task
                except Exception:
                    SLOTS.release()
                    completed[key] = unavailable(task, 'unavailable', 'Specialist unavailable')
            elif not running:
                completed[key] = unavailable(task, 'busy', 'Specialist capacity occupied; retry later')
            else:
                continue
            del pending[key]
        if running:
            done, _ = wait(running, timeout=max(0, deadline - monotonic()), return_when=FIRST_COMPLETED)
            for future in done:
                task = running.pop(future)
                completed[task.id] = future.result()
    results = [completed[task.id] for task in plan.tasks]
    return ToolResult({'plan_status': 'complete' if all(r['status'] == 'ok' for r in results) else 'partial',
        'tasks': results, 'safety_assessment': {'status': 'UNKNOWN',
        'missing_requirements': ['validated_vessel_operating_limits', 'current_official_warnings',
                                 'authoritative_restriction_checks'],
        'note': 'These marine checks alone cannot establish departure suitability.'}},
        success=any(r['status'] in {'ok', 'partial'} for r in results))
