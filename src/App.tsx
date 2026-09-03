import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Activity, ChevronDown, ChevronLeft, ChevronRight, Clock3, Droplets, Info,
  Layers3, LoaderCircle, Menu, Navigation2, Pause, Play, Search, Thermometer, Waves, X,
} from 'lucide-react'
import { fetchCatalog, fetchField } from './api'
import OceanMap from './OceanMap'
import type { Catalog, FieldData, Inspection, LayerId, LayerMeta } from './types'

const LAYER_ICONS = {
  waves: Waves,
  currents: Navigation2,
  temperature: Thermometer,
  sea_level: Activity,
  chlorophyll: Droplets,
}

function nearestTimeIndex(times: string[]): number {
  if (!times.length) return 0
  const now = Date.now()
  let best = 0
  times.forEach((time, index) => {
    if (Math.abs(Date.parse(time) - now) < Math.abs(Date.parse(times[best]) - now)) best = index
  })
  return best
}

function formatTime(value: string, includeDate = true): string {
  return new Intl.DateTimeFormat('en-IN', {
    ...(includeDate ? { weekday: 'short', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function formatAge(hours?: number): string {
  if (hours === undefined) return 'Unknown'
  if (hours < 1) return 'Less than an hour'
  if (hours < 48) return `${Math.round(hours)} hours`
  return `${Math.round(hours / 24)} days`
}

function parseCoordinates(value: string): [number, number] | null {
  const normalized = value
    .trim()
    .replace(/[’′]/g, "'")
    .replace(/[”″]/g, '"')
    .toUpperCase()

  const dmsPattern = /([+-]?\d+(?:\.\d+)?)\s*[°º]\s*(?:(\d+(?:\.\d+)?)\s*')?\s*(?:(\d+(?:\.\d+)?)\s*")?\s*([NSEW])/g
  const dmsMatches = Array.from(normalized.matchAll(dmsPattern))
  if (dmsMatches.length === 2) {
    let latitude: number | null = null
    let longitude: number | null = null
    dmsMatches.forEach((match) => {
      const degrees = Number(match[1])
      const minutes = Number(match[2] || 0)
      const seconds = Number(match[3] || 0)
      const hemisphere = match[4]
      if (minutes >= 60 || seconds >= 60) return
      const sign = hemisphere === 'S' || hemisphere === 'W' ? -1 : 1
      const coordinate = sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600)
      if (hemisphere === 'N' || hemisphere === 'S') latitude = coordinate
      else longitude = coordinate
    })
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return [longitude, latitude]
    }
  }

  const hemispherePattern = /([+-]?\d+(?:\.\d+)?)\s*([NSEW])/g
  const hemisphereMatches = Array.from(normalized.matchAll(hemispherePattern))
  if (hemisphereMatches.length === 2) {
    let latitude: number | null = null
    let longitude: number | null = null
    hemisphereMatches.forEach((match) => {
      const hemisphere = match[2]
      const sign = hemisphere === 'S' || hemisphere === 'W' ? -1 : 1
      const coordinate = sign * Math.abs(Number(match[1]))
      if (hemisphere === 'N' || hemisphere === 'S') latitude = coordinate
      else longitude = coordinate
    })
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return [longitude, latitude]
    }
  }

  const parts = normalized.match(/[+-]?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  if (parts.length !== 2) return null
  let [first, second] = parts
  if (Math.abs(first) > 90 && Math.abs(second) <= 90) [first, second] = [second, first]
  if (Math.abs(first) > 90 || Math.abs(second) > 180) return null
  return [second, first]
}

function LayerRail({ layers, selected, onSelect }: {
  layers: LayerMeta[]
  selected: LayerId
  onSelect: (id: LayerId) => void
}) {
  return (
    <aside className="layer-rail" aria-label="Ocean layers">
      <div className="rail-heading"><Layers3 size={16} /><span>Layers</span></div>
      {layers.map((layer) => {
        const Icon = LAYER_ICONS[layer.id]
        return (
          <button
            key={layer.id}
            type="button"
            className={`layer-button ${selected === layer.id ? 'active' : ''}`}
            disabled={!layer.available}
            onClick={() => onSelect(layer.id)}
          >
            <span className={`layer-orb orb-${layer.id}`}><Icon size={18} /></span>
            <span>{layer.label}</span>
          </button>
        )
      })}
    </aside>
  )
}

function Legend({ layer }: { layer: LayerMeta }) {
  const stops = [0, .25, .5, .75, 1]
  const values = stops.map((stop) => layer.logarithmic
    ? layer.domain[0] * Math.pow(layer.domain[1] / layer.domain[0], stop)
    : layer.domain[0] + (layer.domain[1] - layer.domain[0]) * stop)
  return (
    <div className="legend glass">
      <div className="legend-title"><span>{layer.label}</span><b>{layer.unit}</b></div>
      <div className="legend-gradient" style={{ background: `linear-gradient(90deg, ${layer.palette.join(',')})` }} />
      <div className="legend-values">{values.map((value) => <span key={value}>{value < 1 ? value.toFixed(2) : value.toFixed(1)}</span>)}</div>
    </div>
  )
}

function Timeline({ times, index, playing, onIndex, onPlaying }: {
  times: string[]
  index: number
  playing: boolean
  onIndex: (index: number) => void
  onPlaying: (playing: boolean) => void
}) {
  const current = times[index]
  const dayLabels = useMemo(() => {
    const unique = new Map<string, string>()
    times.forEach((time) => {
      const key = new Date(time).toDateString()
      if (!unique.has(key)) unique.set(key, formatTime(time).split(',')[0])
    })
    return Array.from(unique.values()).slice(0, 6)
  }, [times])
  return (
    <div className="timeline glass">
      <button className="play-button" type="button" onClick={() => onPlaying(!playing)} aria-label={playing ? 'Pause timeline' : 'Play timeline'}>
        {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
      </button>
      <div className="timeline-main">
        <div className="timeline-top">
          <strong>{current ? formatTime(current) : 'No timeline'}</strong>
          <div className="day-labels">{dayLabels.map((day) => <span key={day}>{day}</span>)}</div>
        </div>
        <div className="range-row">
          <button type="button" onClick={() => onIndex(Math.max(0, index - 1))}><ChevronLeft size={18} /></button>
          <input
            type="range"
            min="0"
            max={Math.max(0, times.length - 1)}
            value={index}
            onChange={(event) => onIndex(Number(event.target.value))}
            aria-label="Forecast time"
          />
          <button type="button" onClick={() => onIndex(Math.min(times.length - 1, index + 1))}><ChevronRight size={18} /></button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selectedLayer, setSelectedLayer] = useState<LayerId>('waves')
  const [timeIndex, setTimeIndex] = useState(0)
  const [field, setField] = useState<FieldData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [hover, setHover] = useState<{ inspection: Inspection; x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState(false)
  const [focusPoint, setFocusPoint] = useState<[number, number] | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  useEffect(() => {
    let active = true
    const loadCatalog = () => fetchCatalog()
      .then((result) => {
        if (!active) return
        setCatalog((previous) => {
          const previousLayer = previous?.layers.find((item) => item.id === selectedLayer)
          const nextLayer = result.layers.find((item) => item.id === selectedLayer)
          if (!previous || previousLayer?.updated_at !== nextLayer?.updated_at) {
            setTimeIndex(nearestTimeIndex(nextLayer?.times ?? []))
          }
          return result
        })
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    void loadCatalog()
    const timer = window.setInterval(loadCatalog, 5 * 60 * 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [selectedLayer])

  const layer = catalog?.layers.find((item) => item.id === selectedLayer) ?? null
  const times = layer?.times ?? []

  useEffect(() => {
    if (!layer || !times[timeIndex]) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetchField(selectedLayer, times[timeIndex], controller.signal)
      .then(setField)
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message)
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [layer, selectedLayer, timeIndex, times])

  useEffect(() => {
    if (!playing || times.length < 2) return
    const timer = window.setInterval(() => setTimeIndex((value) => (value + 1) % times.length), 850)
    return () => window.clearInterval(timer)
  }, [playing, times.length])

  const chooseLayer = (id: LayerId) => {
    const next = catalog?.layers.find((candidate) => candidate.id === id)
    setSelectedLayer(id)
    setTimeIndex(nearestTimeIndex(next?.times ?? []))
    setInspection(null)
    setPlaying(false)
  }

  const search = (event: FormEvent) => {
    event.preventDefault()
    const coordinates = parseCoordinates(query)
    setSearchError(!coordinates)
    if (coordinates) setFocusPoint(coordinates)
  }

  return (
    <main className="app-shell">
      <OceanMap
        field={field}
        layer={layer}
        region={catalog?.region ?? null}
        focusPoint={focusPoint}
        onInspect={setInspection}
        onHover={(value, point) => setHover(value && point ? { inspection: value, x: point.x, y: point.y } : null)}
      />

      <header className="topbar glass">
        <button className="menu-button" type="button" aria-label="Menu"><Menu size={22} /></button>
        <div className="brand"><span className="brand-mark">S</span><div><b>SAFE<span>LINK</span></b><small>OCEAN CONDITIONS</small></div></div>
        <form className={`search ${searchError ? 'invalid' : ''}`} onSubmit={search}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Coordinates: 12.6, 80.4 or 12°N 80°E" aria-label="Search latitude and longitude" />
          <button type="submit" aria-label="Search coordinates"><Search size={19} /></button>
        </form>
        <div className="live-status"><span className="live-dot" /> Copernicus live</div>
        <button className="info-toggle" type="button" onClick={() => setInfoOpen(!infoOpen)}><Info size={18} /> Data info <ChevronDown size={15} /></button>
      </header>

      {infoOpen && layer && (
        <section className="info-panel glass">
          <button type="button" onClick={() => setInfoOpen(false)} aria-label="Close information"><X size={17} /></button>
          <span>Observation age</span>
          <strong>{formatAge(layer.observation_age_hours)}</strong>
          <small>Fresh data is checked every 6 hours. Files older than 7 days are removed.</small>
        </section>
      )}

      {catalog && <LayerRail layers={catalog.layers} selected={selectedLayer} onSelect={chooseLayer} />}
      {layer && <Legend layer={layer} />}

      {inspection && layer && (
        <section className="inspection-card glass">
          <button type="button" onClick={() => setInspection(null)} aria-label="Close values"><X size={16} /></button>
          <div className="inspection-time"><Clock3 size={15} />{field ? formatTime(field.time) : ''}</div>
          <div className="inspection-location">{inspection.lat.toFixed(3)}°N · {inspection.lng.toFixed(3)}°E</div>
          <div className="inspection-primary"><span>{layer.label}</span><strong>{inspection.value.toFixed(2)} <small>{layer.unit}</small></strong></div>
          {inspection.period != null && <div className="inspection-row"><span>Period</span><b>{inspection.period.toFixed(1)} s</b></div>}
          {inspection.direction != null && <div className="inspection-row"><span>Direction</span><b>{Math.round(inspection.direction)}°</b></div>}
        </section>
      )}

      {hover && layer && (
        <div className="hover-value" style={{ left: hover.x + 16, top: hover.y + 82 }}>
          {hover.inspection.value.toFixed(2)} {layer.unit}
        </div>
      )}

      {times.length > 0 && (
        <Timeline times={times} index={timeIndex} playing={playing} onIndex={setTimeIndex} onPlaying={setPlaying} />
      )}

      {loading && <div className="loading-pill glass"><LoaderCircle className="spin" size={18} /> Loading ocean data</div>}
      {error && <div className="error-banner">{error}. Make sure the SafeLink backend is running on port 8000.</div>}
    </main>
  )
}
