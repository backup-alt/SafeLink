"""Validated bounded read-only plans. No model-generated executable code."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from .tools import TOOL_MODELS, ToolResult


def execute_plan(tools, plan):
    # Validate every child before executing any. Plans cannot recursively expand.
    for task in plan.tasks:
        TOOL_MODELS[task.tool][0].model_validate_json(task.arguments_json)

    def execute(task):
        try:
            result = tools.run(task.tool, task.arguments_json)
            data = result.data
            status = 'ok' if result.success else 'unavailable'
            if isinstance(data.get('samples'), dict) and any(
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
            return {'task_id': task.id, 'tool': task.tool, 'status': 'unavailable',
                    'data': {'error': 'Specialist unavailable'}, 'evidence': None}

    with ThreadPoolExecutor(max_workers=min(4, len(plan.tasks))) as pool:
        results = list(pool.map(execute, plan.tasks))
    return ToolResult({'plan_status': 'complete' if all(r['status'] == 'ok' for r in results) else 'partial',
        'tasks': results, 'safety_assessment': {'status': 'UNKNOWN',
        'missing_requirements': ['validated_vessel_operating_limits', 'current_official_warnings',
                                 'authoritative_restriction_checks'],
        'note': 'These marine checks alone cannot establish departure suitability.'}},
        success=any(r['status'] != 'unavailable' for r in results))
