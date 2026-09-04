export type LayerId = 'waves' | 'currents' | 'temperature' | 'sea_level' | 'chlorophyll'

export interface PFZProperties {
  Sno?: string | number | null
  Length?: number | null
  Year?: string | number | null
  Julian_day?: string | number | null
  advisory_date: string | null
  [key: string]: unknown
}

export interface PFZFeature {
  type: 'Feature'
  id: number
  geometry: { type: 'MultiLineString'; coordinates: number[][][] }
  properties: PFZProperties
}

export interface PFZResponse {
  data: { type: 'FeatureCollection'; features: PFZFeature[] }
  metadata: {
    source: 'INCOIS'
    fetched_at: string
    advisory_date: string | null
    advisory_dates: string[]
    feature_count: number
    stale: boolean
  }
}

export interface NearestPFZ {
  feature: PFZFeature
  origin: { lng: number; lat: number }
  point: { lng: number; lat: number }
  distance_km: number
  bearing_degrees: number | null
  metadata: PFZResponse['metadata']
}

export interface ConditionSample extends Inspection {
  time: string
  unit: string
}

export interface LayerMeta {
  id: LayerId
  label: string
  unit: string
  times: string[]
  available: boolean
  updated_at?: string
  observation_age_hours?: number
  palette: string[]
  domain: [number, number]
  logarithmic: boolean
  vector: boolean
}

export interface Catalog {
  region: {
    minimum_longitude: number
    maximum_longitude: number
    minimum_latitude: number
    maximum_latitude: number
  }
  layers: LayerMeta[]
}

export interface FieldData {
  layer: LayerId
  time: string
  latitudes: number[]
  longitudes: number[]
  values: (number | null)[][]
  unit: string
  source_file: string
  u?: (number | null)[][]
  v?: (number | null)[][]
  extras: {
    period?: (number | null)[][]
    direction?: (number | null)[][]
  }
}

export interface Inspection {
  lng: number
  lat: number
  value: number
  period?: number | null
  direction?: number | null
}
