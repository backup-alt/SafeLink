"""Opt-in offline UI fixture: python -m scripts.mock_chat_server (port 8014).

Never creates an OpenAI client. Not imported by production startup.
"""
import asyncio
import os
import copy
from types import SimpleNamespace as NS

os.environ['OPENAI_API_KEY'] = 'offline-fixture-not-a-real-key'
os.environ['SAFELINK_AUTO_REFRESH'] = 'false'
os.environ['HF_CHAT_DATASET_REPO'] = ''
os.environ['HF_CHAT_TOKEN'] = ''

from backend.app import app, chat_router, pfz_service
from backend.tests.test_ai import FakeClient, FakeStream, complete, e, text


pfz_service._fetch = lambda: {'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'properties': {'Sno': '097', 'Year': 2026, 'Julian_day': '247'},
     'geometry': {'type': 'MultiLineString', 'coordinates': [[[80, 10], [82, 10]]]}}]}


class SlowStream(FakeStream):
    async def iterate(self):
        for item in self.items:
            await asyncio.sleep(.18)
            yield item


class DemoClient(FakeClient):
    async def create(self, **kwargs):
        self.calls.append(kwargs)
        output = kwargs['input']
        if output[0]['type'] == 'function_call_output' if 'type' in output[0] else False:
            if output[0]['call_id'] == 'nearest':
                call = NS(type='function_call', name='update_map', call_id='map', arguments='{"command":"highlight_pfz","pfz_id":"097","latitude":null,"longitude":null,"zoom":null,"layer":null,"time":null}')
                return SlowStream([complete('map-response', [call])])
            item = NS(type='web_search_call', id='web1', model_dump=lambda: {'status': 'completed', 'action': {'sources': [{'url': 'https://incois.gov.in/', 'title': 'INCOIS — offline fixture source'}]}})
            return SlowStream([e('response.web_search_call.in_progress', item_id='web1'), e('response.output_item.done', item=item),
                text('Offline test answer: '), text('PFZ 097 highlighted. '), text('This is fixture data, not a live advisory. [1]'),
                text('\n\n**Fixture summary**\n\n| Parameter | Value |\n| --- | --- |\n| Mode | Offline test |\n\n- No live forecast claims.\n- No paid API calls.'),
                e('response.output_text.annotation.added', item_id='message-1', content_index=0,
                  annotation={'type': 'url_citation', 'url': 'https://incois.gov.in/', 'title': 'INCOIS — fixture', 'start_index': 81, 'end_index': 84}), complete('answer')])
        call = NS(type='function_call', name='get_nearest_pfz', call_id='nearest', arguments='{"latitude":11,"longitude":81}')
        return SlowStream([complete('nearest-response', [call])])


chat_router.agent.client_factory = lambda: DemoClient([])

# Optional in-memory archive fixture: never calls Hugging Face.
if os.getenv('SAFELINK_TEST_ARCHIVE') == 'true':
    records = {}
    chat_router.archive.repo = 'fixture/private'
    chat_router.archive.token = 'offline-fixture'
    chat_router.archive.client = lambda: None
    chat_router.archive.read = lambda owner: copy.deepcopy(records.get(owner, {}))
    def archive_update(owner, key, session=None):
        entries = records.setdefault(owner, {})
        if session is None:
            entries.pop(key, None)
        else:
            entries[key] = {'messages': copy.deepcopy(session.messages), 'turns': session.turns}
    chat_router.archive.update = archive_update

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8014, lifespan='off')
