import type { Catalog, FieldData, LayerId } from './types'

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`SafeLink data service returned ${response.status}`)
  return response.json() as Promise<T>
}

export const fetchCatalog = (signal?: AbortSignal) => getJson<Catalog>('/api/catalog', signal)

export const fetchField = (layer: LayerId, time: string, signal?: AbortSignal) =>
  getJson<FieldData>(`/api/field/${layer}?time=${encodeURIComponent(time)}`, signal)
