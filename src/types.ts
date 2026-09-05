export type LayerId = 'waves' | 'currents' | 'temperature' | 'sea_level' | 'chlorophyll'
export type MapView = 'ocean' | 'nautical' | 'vessels'

export interface Vessel {
  mmsi: string
  name: string
  type: string
  latitude: number
  longitude: number
  speed: number
  course: number
  heading: number
  destination: string
  eta: string
  lastUpdate: string
  navStatus: string
  source: string
}

export interface NavRoute {
  coordinates: [number, number][]
  distance_km: number
  eta_hours: number
  heading: number
  warnings: NavWarning[]
  legs: { from: [number, number]; to: [number, number]; distance_km: number; heading: number; steps: number }[]
  distance_labels: { position: [number, number]; distance_km: number }[]
  speed_knots: number
}

export interface NauticalMeasurement {
  value: number | null
  unit: string
  source: string
  time?: string
  status?: string
}

export interface NauticalPointDetails {
  coordinates: { lng: number; lat: number }
  depth: NauticalMeasurement
  wave_height: NauticalMeasurement | null
  wave_direction: NauticalMeasurement | null
  wave_period: NauticalMeasurement | null
  temperature: NauticalMeasurement | null
  current: NauticalMeasurement | null
  current_direction: NauticalMeasurement | null
  fetched_at: string | null
  note: string
}

export interface GeocodeResult {
  name: string
  latitude: number
  longitude: number
  type?: string
  importance?: number
}

export interface SavedNavRoute {
  id: string
  name: string
  savedAt: string
  origin: [number, number]
  destination: [number, number]
  waypoints: [number, number][]
  speed_knots: number
  distance_km: number
  eta_hours: number
  heading: number
  route: NavRoute
  originDetails: NauticalPointDetails | null
  destinationDetails: NauticalPointDetails | null
}

export interface NavWarning {
  type: 'shallow' | 'restricted' | 'hazard' | 'traffic' | 'info'
  message: string
  location: [number, number]
  severity: 'info' | 'warning' | 'danger'
}

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

export interface OriginLocation {
  point: [number, number]
  source: 'device' | 'map' | 'coordinates'
  accuracy?: number
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
