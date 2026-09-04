from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

Layer = Literal['waves', 'currents', 'temperature', 'sea_level', 'chlorophyll']
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Point(StrictModel):
    latitude: Latitude
    longitude: Longitude


def iso_time(value):
    if value is not None:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('Time requires UTC offset')
    return value


class MapContext(StrictModel):
    center: Point | None = None
    zoom: float = Field(default=4, ge=0, le=22, allow_inf_nan=False)
    clicked_location: Point | None = None
    active_layer: Layer = 'waves'
    selected_pfz: str | None = Field(default=None, max_length=80)
    selected_time: str | None = Field(default=None, max_length=40)
    timezone: str = Field(default='UTC', max_length=80)
    _time = field_validator('selected_time')(iso_time)


class ChatRequest(StrictModel):
    conversation_id: UUID
    message: str = Field(min_length=1, max_length=4000)
    map_context: MapContext = Field(default_factory=MapContext)

    @field_validator('message')
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError('Message must not be blank')
        return value.strip()


class MarineArgs(Point):
    time: str | None = Field(max_length=40)
    layers: list[Layer] = Field(min_length=1, max_length=5)
    _time = field_validator('time')(iso_time)


class PFZArgs(StrictModel):
    pfz_id: str = Field(min_length=1, max_length=80)


class LocationArgs(StrictModel):
    name: str = Field(min_length=2, max_length=100)


class EmptyArgs(StrictModel):
    pass


class FlyTo(Point):
    type: Literal['fly_to', 'place_marker']
    zoom: float = Field(ge=2, le=14, allow_inf_nan=False)


class Highlight(PFZArgs):
    type: Literal['highlight_pfz']


class SelectLayer(StrictModel):
    type: Literal['select_layer']
    layer: Layer


class SetTime(StrictModel):
    type: Literal['set_time']
    time: str = Field(max_length=40)
    _time = field_validator('time')(iso_time)


class ClearMap(StrictModel):
    type: Literal['clear_map_highlights']


MapAction = Annotated[FlyTo | Highlight | SelectLayer | SetTime | ClearMap, Field(discriminator='type')]
MAP_ACTION = TypeAdapter(MapAction)


class MapArgs(StrictModel):
    command: Literal['fly_to', 'place_marker', 'highlight_pfz', 'select_layer', 'set_time', 'clear_map_highlights']
    latitude: Latitude | None
    longitude: Longitude | None
    zoom: float | None = Field(ge=2, le=14, allow_inf_nan=False)
    pfz_id: str | None = Field(max_length=80)
    layer: Layer | None
    time: str | None = Field(max_length=40)
    _time = field_validator('time')(iso_time)

    def action(self):
        fields = {'fly_to': ['latitude', 'longitude', 'zoom'], 'place_marker': ['latitude', 'longitude', 'zoom'],
                  'highlight_pfz': ['pfz_id'], 'select_layer': ['layer'], 'set_time': ['time'], 'clear_map_highlights': []}
        return MAP_ACTION.validate_python({'type': self.command, **{key: getattr(self, key) for key in fields[self.command]}})


class WebSource(StrictModel):
    url: str
    title: str


class StreamEvent(StrictModel):
    type: Literal['status', 'tool_start', 'tool_result', 'web_search_start', 'web_search_result',
                  'map_action', 'text_delta', 'citation', 'error', 'done']
    label: str | None = None
    id: str | None = None
    tool: str | None = None
    source: str | None = None
    success: bool | None = None
    text: str | None = None
    action: MapAction | None = None
    sources: list[WebSource] | None = None
    source_count: int | None = None
    start: int | None = None
    end: int | None = None
    url: str | None = None
    title: str | None = None


def event(kind, **kwargs):
    return StreamEvent(type=kind, **kwargs).model_dump(mode='json', exclude_none=True)
