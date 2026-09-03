export type LayerId = 'waves' | 'currents' | 'temperature' | 'sea_level' | 'chlorophyll'

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
