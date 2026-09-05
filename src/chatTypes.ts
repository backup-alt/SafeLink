import type { LayerId } from './types'

export interface MapContext {
  center: { latitude: number; longitude: number } | null
  zoom: number
  clicked_location: { latitude: number; longitude: number } | null
  active_layer: LayerId
  selected_pfz: string | null
  selected_time: string | null
  timezone: string
}
export type MapAction =
  | { type: 'fly_to' | 'place_marker'; latitude: number; longitude: number; zoom: number }
  | { type: 'highlight_pfz'; pfz_id: string }
  | { type: 'select_layer'; layer: LayerId }
  | { type: 'set_time'; time: string }
  | { type: 'clear_map_highlights' | 'zoom_in' | 'zoom_out' | 'request_location' }
export interface WebSource { url: string; title: string }
export interface Citation extends WebSource { start: number; end: number }
export interface AgentActivity { id: string; label: string; state: 'running' | 'done' | 'failed'; source?: string }
export interface ToolActivity extends AgentActivity { tool?: string }
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; text: string; activities: ToolActivity[]
  sources: WebSource[]; citations: Citation[]; state: 'streaming' | 'done' | 'error' | 'stopped'; error?: string
}
export interface ConversationState { conversation_id: string }
export interface ChatRequest { conversation_id: string; message: string; map_context: MapContext }
export type ChatStreamEvent =
  | { type: 'status' | 'error'; label: string }
  | { type: 'tool_start' | 'tool_result'; id: string; tool: string; label: string; source?: string; success?: boolean }
  | { type: 'web_search_start'; id: string; label: string }
  | { type: 'web_search_result'; id: string; label: string; sources: WebSource[]; source_count: number; success?: boolean }
  | { type: 'map_action'; action: MapAction; label: string; id?: string }
  | { type: 'text_delta'; text: string }
  | ({ type: 'citation' } & Citation)
  | { type: 'done' }

const layers = ['waves', 'currents', 'temperature', 'sea_level', 'chlorophyll']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const numeric = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v: unknown, max = 10000): v is string => typeof v === 'string' && v.length <= max
export function safeWebURL(value: unknown): value is string {
  if (!text(value, 2048)) return false
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}
export function isMapAction(value: unknown): value is MapAction {
  if (!record(value)) return false
  const keys: Record<string, string[]> = { fly_to: ['type', 'latitude', 'longitude', 'zoom'], place_marker: ['type', 'latitude', 'longitude', 'zoom'],
    highlight_pfz: ['type', 'pfz_id'], select_layer: ['type', 'layer'], set_time: ['type', 'time'], clear_map_highlights: ['type'],
    zoom_in: ['type'], zoom_out: ['type'], request_location: ['type'] }
  if (!text(value.type) || !Object.hasOwn(keys, value.type) || Object.keys(value).some(k => !keys[value.type as string].includes(k))) return false
  switch (value.type) {
    case 'fly_to': case 'place_marker': return numeric(value.latitude, -90, 90) && numeric(value.longitude, -180, 180) && numeric(value.zoom, 2, 14)
    case 'highlight_pfz': return text(value.pfz_id, 80) && value.pfz_id.length > 0
    case 'select_layer': return typeof value.layer === 'string' && layers.includes(value.layer)
    case 'set_time': return text(value.time, 40) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value.time) && Number.isFinite(Date.parse(value.time))
    case 'clear_map_highlights': case 'zoom_in': case 'zoom_out': case 'request_location': return true
    default: return false
  }
}
export function parseChatEvent(value: unknown): ChatStreamEvent {
  if (!record(value)) throw new Error('Invalid chat stream')
  let valid = false
  switch (value.type) {
    case 'done': valid = true; break
    case 'status': case 'error': valid = text(value.label); break
    case 'text_delta': valid = text(value.text); break
    case 'map_action': valid = isMapAction(value.action) && text(value.label) && (value.id === undefined || text(value.id, 80)); break
    case 'tool_start': case 'tool_result': valid = text(value.id) && text(value.tool) && text(value.label) && (value.source === undefined || text(value.source)); break
    case 'web_search_start': valid = text(value.id) && text(value.label); break
    case 'web_search_result': valid = text(value.id) && text(value.label) && numeric(value.source_count, 0, 10000) && Array.isArray(value.sources) && value.sources.length <= 20 && value.sources.every(s => record(s) && safeWebURL(s.url) && text(s.title)); break
    case 'citation': valid = safeWebURL(value.url) && text(value.title) && numeric(value.start, 0, 100000) && numeric(value.end, Number(value.start), 100000); break
  }
  if (!valid) throw new Error('Invalid chat stream')
  return value as unknown as ChatStreamEvent
}
