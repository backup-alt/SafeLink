import type { Catalog, ConditionSample, FieldData, GeocodeResult, LayerId, NauticalPointDetails, NavRoute, NearestPFZ, PFZResponse, Vessel } from './types'

const fieldCache = new Map<string, FieldData>()
const pendingFields = new Map<string, Promise<FieldData>>()
const MAX_CACHED_FIELDS = 8

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`SafeLink data service returned ${response.status}`)
  return response.json() as Promise<T>
}

export const fetchCatalog = (signal?: AbortSignal) => getJson<Catalog>('/api/catalog', signal)

export const fetchPFZ = (signal?: AbortSignal) => getJson<PFZResponse>('/api/pfz', signal)

export const fetchNearestPFZ = (point: [number, number], signal?: AbortSignal) =>
  getJson<NearestPFZ>(`/api/pfz/nearest?longitude=${point[0]}&latitude=${point[1]}`, signal)

export const fetchCondition = (layer: LayerId, point: NearestPFZ['point'], time?: string, signal?: AbortSignal) => {
  const params = new URLSearchParams({ longitude: String(point.lng), latitude: String(point.lat) })
  if (time) params.set('time', time)
  return getJson<ConditionSample>(`/api/value/${layer}?${params}`, signal)
}

export const fetchField = (layer: LayerId, time: string, signal?: AbortSignal) => {
  const key = `${layer}:${time}`
  const cached = fieldCache.get(key)
  if (cached) {
    fieldCache.delete(key)
    fieldCache.set(key, cached)
    return Promise.resolve(cached)
  }
  const pending = pendingFields.get(key)
  if (pending && !signal) return pending
  const request = getJson<FieldData>(`/api/field/${layer}?time=${encodeURIComponent(time)}`, signal)
    .then((value) => {
      fieldCache.set(key, value)
      while (fieldCache.size > MAX_CACHED_FIELDS) fieldCache.delete(fieldCache.keys().next().value!)
      return value
    })
    .finally(() => pendingFields.delete(key))
  if (!signal) pendingFields.set(key, request)
  return request
}

export const prefetchField = (layer: LayerId, time?: string) => {
  if (time) void fetchField(layer, time).catch(() => undefined)
}

export const fetchVessels = (bbox: { west: number; south: number; east: number; north: number }, signal?: AbortSignal) => {
  const params = new URLSearchParams({
    west: String(bbox.west),
    south: String(bbox.south),
    east: String(bbox.east),
    north: String(bbox.north),
  })
  return getJson<Vessel[]>(`/api/vessels?${params}`, signal)
}

export const fetchRoute = async (
  origin: [number, number],
  destination: [number, number],
  waypoints: [number, number][] = [],
  speedKnots: number = 10,
  signal?: AbortSignal,
) => {
  const response = await fetch('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin, destination, waypoints, speed_knots: speedKnots }),
    signal,
  })
  if (!response.ok) throw new Error(`Route calculation failed: ${response.status}`)
  return response.json() as Promise<NavRoute>
}

export const fetchNauticalClick = (lng: number, lat: number, signal?: AbortSignal) =>
  getJson<{ coordinates: { lng: number; lat: number }; conditions: Record<string, { value: number; unit: string; time: string } | null> }>(
    `/api/nautical/click?longitude=${lng}&latitude=${lat}`, signal
  )

export const fetchNauticalPoint = (point: [number, number], signal?: AbortSignal) =>
  getJson<NauticalPointDetails>(`/api/nautical/point?longitude=${point[0]}&latitude=${point[1]}`, signal)

export const searchPlaces = (query: string, signal?: AbortSignal) =>
  getJson<GeocodeResult[]>(`/api/geocode?q=${encodeURIComponent(query)}`, signal)
