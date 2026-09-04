import type { Catalog, FieldData, LayerId, PFZResponse } from './types'

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
