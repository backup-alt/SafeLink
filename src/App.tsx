import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ChevronDown, ChevronLeft, ChevronRight, Clock3, Droplets, Info,
  Layers3, LoaderCircle, Menu, Navigation2, Pause, Play, Search, Thermometer, Waves, X,
} from 'lucide-react'
import { fetchCatalog, fetchCondition, fetchField, fetchNearestPFZ, fetchPFZ, prefetchField } from './api'
import OceanMap from './OceanMap'
import type { Catalog, ConditionSample, FieldData, Inspection, LayerId, LayerMeta, NearestPFZ, OriginLocation, PFZFeature, PFZResponse } from './types'

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
    const unique = new Map<string, { label: string; position: number }>()
    times.forEach((time, timeIndex) => {
      const key = new Date(time).toDateString()
      if (!unique.has(key)) unique.set(key, {
        label: formatTime(time).split(',')[0],
        position: times.length > 1 ? timeIndex / (times.length - 1) * 100 : 0,
      })
    })
    return Array.from(unique.values())
  }, [times])
  return (
    <div className="timeline glass">
      <button className="play-button" type="button" onClick={() => onPlaying(!playing)} aria-label={playing ? 'Pause timeline' : 'Play timeline'}>
        {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
      </button>
      <div className="timeline-main">
        <div className="timeline-top">
          <strong>{current ? formatTime(current) : 'No timeline'}</strong>
          <div className="day-labels">{dayLabels.map((day) => (
            <span key={`${day.label}-${day.position}`} style={{ left: `${day.position}%` }}>{day.label}</span>
          ))}</div>
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
  const [pfz, setPFZ] = useState<PFZResponse | null>(null)
  const [pfzEnabled, setPFZEnabled] = useState(true)
  const [pfzLoading, setPFZLoading] = useState(true)
  const [pfzError, setPFZError] = useState(false)
  const [selectedPFZ, setSelectedPFZ] = useState<PFZFeature | null>(null)
  const [nearestOrigin, setNearestOrigin] = useState<[number, number] | null>(null)
  const [nearest, setNearest] = useState<NearestPFZ | null>(null)
  const [nearestLoading, setNearestLoading] = useState(false)
  const [nearestError, setNearestError] = useState<string | null>(null)
  const [conditions, setConditions] = useState<Partial<Record<LayerId, ConditionSample | null>>>({})
  const [locationStep, setLocationStep] = useState<'choose' | 'map' | 'locating' | 'confirm' | null>(null)
  const [originLocation, setOriginLocation] = useState<OriginLocation | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const locationRequest = useRef(0)
  const locationHeading = useRef<HTMLHeadingElement>(null)

  const cancelLocation = useCallback(() => {
    locationRequest.current += 1
    setLocationStep(null)
    setLocationError(null)
    setOriginLocation(null)
  }, [])

  useEffect(() => {
    if (!locationStep) return
    locationHeading.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelLocation() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [locationStep, cancelLocation])
  useEffect(() => () => { locationRequest.current += 1 }, [])

  const openLocationPicker = () => {
    locationRequest.current += 1
    setLocationStep('choose')
    setLocationError(null)
    setOriginLocation(null)
    setNearestOrigin(null)
    setInspection(null)
    setSelectedPFZ(null)
    setPlaying(false)
  }

  const locateDevice = () => {
    const request = ++locationRequest.current
    setLocationError(null)
    setOriginLocation(null)
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocationError('Device location is unavailable here. Open SafeLink over HTTPS or localhost, or choose your position on the map.')
      setLocationStep('choose')
      return
    }
    setLocationStep('locating')
    navigator.geolocation.getCurrentPosition((position) => {
      if (request !== locationRequest.current) return
      const { longitude, latitude, accuracy } = position.coords
      const point: [number, number] = [longitude, latitude]
      setOriginLocation({ point, source: 'device', accuracy })
      setFocusPoint(point)
      setLocationStep('confirm')
    }, (error) => {
      if (request !== locationRequest.current) return
      setLocationStep('choose')
      setLocationError(error.code === 1
        ? 'Location access is blocked. Allow Location in your browser’s site settings and enable location services in your computer’s privacy settings, then try again. You can also click your position on the map.'
        : error.code === 3
          ? 'Finding your location timed out. Check that device location services are on, retry, or choose your position on the map.'
          : 'Your device could not determine a location. Turn on location services, retry, or choose your position on the map.')
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
  }

  useEffect(() => {
    if (!nearestOrigin) { setNearest(null); setNearestLoading(false); setNearestError(null); return }
    const controller = new AbortController()
    setNearestLoading(true)
    setNearest(null)
    setNearestError(null)
    setSelectedPFZ(null)
    setInspection(null)
    fetchNearestPFZ(nearestOrigin, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setNearest(result); setPFZEnabled(true) }
    }).catch((reason: Error) => {
      if (!controller.signal.aborted) setNearestError(`Nearest PFZ unavailable. ${reason.message}`)
    }).finally(() => { if (!controller.signal.aborted) setNearestLoading(false) })
    return () => controller.abort()
  }, [nearestOrigin, pfz?.data])

  const selectMapPoint = useCallback((point: [number, number]) => {
    setNearestOrigin(null)
    if (locationStep) {
      locationRequest.current += 1
      setOriginLocation({ point, source: 'map' })
      setLocationStep('confirm')
      setLocationError(null)
      setInspection(null)
      setSelectedPFZ(null)
      return true
    }
    setOriginLocation(null)
    return false
  }, [locationStep])

  useEffect(() => {
    const controller = new AbortController()
    let timer = 0
    const load = async () => {
      try {
        const result = await fetchPFZ(controller.signal)
        if (controller.signal.aborted) return
        setPFZ(result)
        setPFZError(false)
        setSelectedPFZ(null)
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn('PFZ overlay unavailable', error)
        setPFZError(true)
        setPFZ((previous) => previous ? { ...previous, metadata: { ...previous.metadata, stale: true } } : null)
      } finally {
        if (!controller.signal.aborted) {
          setPFZLoading(false)
          timer = window.setTimeout(load, 5 * 60 * 1000)
        }
      }
    }
    void load()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [])
  const updateHover = useCallback((value: Inspection | null, point?: { x: number; y: number }) => {
    setHover(value && point ? { inspection: value, x: point.x, y: point.y } : null)
  }, [])

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
  const selectedTime = times[timeIndex]

  useEffect(() => {
    setConditions({})
    if (!nearest) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const ids: LayerId[] = ['temperature', 'chlorophyll', 'waves', 'currents', 'sea_level']
      ids.forEach((id) => {
        fetchCondition(id, nearest.point, selectedTime, controller.signal)
          .then((sample) => { if (!controller.signal.aborted) setConditions((prev) => ({ ...prev, [id]: sample })) })
          .catch(() => { if (!controller.signal.aborted) setConditions((prev) => ({ ...prev, [id]: null })) })
      })
    }, 250)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [nearest, selectedTime])

  useEffect(() => {
    if (!layer || !selectedTime) return
    const controller = new AbortController()
    const delay = window.setTimeout(() => {
    setLoading(true)
    setError(null)
    fetchField(selectedLayer, selectedTime, controller.signal)
      .then((nextField) => {
        setField(nextField)
        const nextIndex = (timeIndex + 1) % times.length
        if (times.length > 1) prefetchField(selectedLayer, times[nextIndex])
      })
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    }, 90)
    return () => {
      window.clearTimeout(delay)
      controller.abort()
    }
  }, [layer?.id, layer?.updated_at, selectedLayer, selectedTime, timeIndex, times.length])

  useEffect(() => {
    if (!playing || loading || times.length < 2 || field?.time !== selectedTime) return
    const timer = window.setTimeout(
      () => setTimeIndex((value) => (value + 1) % times.length),
      1100,
    )
    return () => window.clearTimeout(timer)
  }, [playing, loading, field?.time, selectedTime, times.length])

  const chooseLayer = (id: LayerId) => {
    const next = catalog?.layers.find((candidate) => candidate.id === id)
    setSelectedLayer(id)
    setTimeIndex(nearestTimeIndex(next?.times ?? []))
    setInspection(null)
    setHover(null)
    setField(null)
    setPlaying(false)
  }

  const search = (event: FormEvent) => {
    event.preventDefault()
    const coordinates = parseCoordinates(query)
    setSearchError(!coordinates)
    if (coordinates) {
      setFocusPoint(coordinates)
      selectMapPoint(coordinates)
      if (locationStep) setOriginLocation({ point: coordinates, source: 'coordinates' })
    }
  }

  return (
    <main className="app-shell">
      <OceanMap
        field={field}
        layer={layer}
        region={catalog?.region ?? null}
        focusPoint={focusPoint}
        onInspect={setInspection}
        onHover={updateHover}
        pfz={pfz}
        pfzEnabled={pfzEnabled}
        onPFZInspect={setSelectedPFZ}
        onMapPoint={selectMapPoint}
        nearestPFZ={pfzEnabled ? nearest : null}
        originLocation={originLocation}
        pickingLocation={!!locationStep && locationStep !== 'confirm'}
      />

      <header className="topbar glass">
        <button className="menu-button" type="button" aria-label="Menu"><Menu size={22} /></button>
        <div className="brand"><span className="brand-mark">S</span><div><b>SAFE<span>LINK</span></b><small>OCEAN CONDITIONS</small></div></div>
        <form className={`search ${searchError ? 'invalid' : ''}`} onSubmit={search}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Coordinates: 12.6, 80.4 or 12°N 80°E" aria-label="Search latitude and longitude" />
          <button type="submit" aria-label="Search coordinates"><Search size={19} /></button>
        </form>
        <div className="live-status"><span className="live-dot" /> Copernicus Marine</div>
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
      <section className="overlay-control glass" aria-label="Map overlays">
        <div className="rail-heading">Overlays</div>
        <label><input type="checkbox" checked={pfzEnabled && !!pfz} disabled={!pfz}
          onChange={(event) => { setPFZEnabled(event.target.checked); setSelectedPFZ(null) }} />
          <span>Potential Fishing Zones</span></label>
        <small role="status">{pfzLoading ? 'Loading INCOIS advisory…'
          : !pfz ? 'PFZ unavailable · retrying automatically'
          : `${pfz.metadata.stale || pfzError ? 'Cached · stale · ' : ''}INCOIS · ${pfz.metadata.feature_count} PFZ features`}</small>
        {pfz && <small>Advisory: {pfz.metadata.advisory_date ?? 'Date unavailable'}{pfz.metadata.advisory_dates.length > 1 ? ' (latest; mixed dates)' : ''}</small>}
        {pfz && <small title={pfz.metadata.fetched_at}>Fetched: {new Date(pfz.metadata.fetched_at).toLocaleString('en-IN')}</small>}
        <button className="nearest-pfz-button" type="button" disabled={nearestLoading}
          onClick={openLocationPicker}>
          {nearestLoading ? 'Finding nearest PFZ…' : 'Find nearest PFZ'}
        </button>
        <small>Choose your starting location in the next step.</small>
        {nearestError && <small role="status">{nearestError}</small>}
      </section>
      {layer && <Legend layer={layer} />}

      {locationStep && <section className="location-picker glass" aria-labelledby="location-heading">
        <button className="location-close" type="button" onClick={cancelLocation} aria-label="Cancel location selection"><X size={17} /></button>
        <h2 id="location-heading" tabIndex={-1} ref={locationHeading}>Where are you starting from?</h2>
        <p>Select your current or departure location—not a destination. We’ll find the nearest PFZ from there.</p>
        <div className="location-actions">
          <button className="nearest-pfz-button" type="button" disabled={locationStep === 'locating'} onClick={locateDevice}>
            {locationStep === 'locating' ? 'Finding your location…' : 'Use my current location'}
          </button>
          <button className="nearest-pfz-button" type="button" onClick={() => {
            locationRequest.current += 1; setLocationStep('map'); setLocationError(null); setOriginLocation(null)
          }}>Choose on map</button>
        </div>
        <p role="status">{locationStep === 'map' ? 'Click your starting position anywhere on the map. You can also enter coordinates in the search bar.'
          : locationStep === 'locating' ? 'Allow the browser’s location request. You can select a map point instead at any time.'
          : locationStep === 'confirm' ? 'Check the marked position, then confirm below. Click another map point to adjust it.'
          : 'Use device location, or click your starting point on the map.'}</p>
        {locationError && <p role="alert" className="location-error">{locationError}</p>}
        {originLocation && locationStep === 'confirm' && <div className="location-confirm">
          <strong>{originLocation.source === 'device' ? 'Device-reported location' : 'Selected starting location'}</strong>
          <p>{originLocation.point[1].toFixed(5)}°, {originLocation.point[0].toFixed(5)}°</p>
          {originLocation.accuracy !== undefined && <p>Reported accuracy: approximately {Math.round(originLocation.accuracy).toLocaleString()} m.
            {originLocation.accuracy > 1000 ? ' This is a coarse location—check the marker carefully or select your position manually.' : ' Check the marker before continuing.'}</p>}
          <button className="nearest-pfz-button" type="button" onClick={() => {
            setLocationStep(null); setNearestOrigin([...originLocation.point]); setPlaying(false)
          }}>Find PFZ from this location</button>
        </div>}
        <small>Location access is optional. If it is switched off or denied, SafeLink cannot determine your actual location. No continuous tracking.</small>
      </section>}

      {nearest && pfzEnabled && (
        <section className="inspection-card glass nearest-pfz-card" aria-label="Nearest PFZ result">
          <button type="button" onClick={() => setNearestOrigin(null)} aria-label="Close nearest PFZ"><X size={16} /></button>
          <div className="inspection-time">Nearest PFZ · INCOIS {nearest.feature.properties.Sno ?? '—'}</div>
          <strong>{nearest.distance_km.toFixed(1)} km {nearest.bearing_degrees === null ? '(at PFZ)' : `${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(nearest.bearing_degrees / 45) % 8]} · ${nearest.bearing_degrees.toFixed(0)}° true`}</strong>
          <small>From {nearest.origin.lat.toFixed(4)}°, {nearest.origin.lng.toFixed(4)}°</small>
          {originLocation?.accuracy !== undefined && <small>Device-reported accuracy: approximately {Math.round(originLocation.accuracy).toLocaleString()} m</small>}
          <small>Nearest point: {nearest.point.lat.toFixed(4)}°, {nearest.point.lng.toFixed(4)}°</small>
          <small>Advisory: {nearest.feature.properties.advisory_date ?? 'Unknown'}{nearest.metadata.stale || pfz?.metadata.stale || pfzError ? ' · Cached / stale' : ''}</small>
          <button className="nearest-pfz-button nearest-show-point" type="button" onClick={() => setFocusPoint([nearest.point.lng, nearest.point.lat])}>Show nearest point</button>
          {(['temperature', 'chlorophyll', 'waves', 'currents', 'sea_level'] as LayerId[]).map((id) => {
            const sample = conditions[id]
            return <div className="nearest-condition" key={id}>
              <div className="inspection-row"><span>{catalog?.layers.find((item) => item.id === id)?.label ?? id}</span>
                <b>{sample === undefined ? 'Loading…' : sample === null ? 'Unavailable' : `${sample.value.toFixed(2)} ${sample.unit}`}</b></div>
              {sample && <small>Sample: {formatTime(sample.time)} ({sample.time})</small>}
            </div>
          })}
          <small>Copernicus nearest-grid samples at the nearest available time to the timeline. Direct spherical distance—not a safe sea route or a catch guarantee.</small>
        </section>
      )}

      {selectedPFZ && pfzEnabled && !nearest && (
        <section className="inspection-card glass pfz-inspection" aria-label="PFZ advisory information">
          <button type="button" onClick={() => setSelectedPFZ(null)} aria-label="Close PFZ information"><X size={16} /></button>
          <div className="inspection-time">Potential Fishing Zone</div>
          <div className="inspection-row"><span>Source</span><b>INCOIS</b></div>
          <div className="inspection-row"><span>PFZ</span><b>{selectedPFZ.properties.Sno ?? 'Not supplied'}</b></div>
          <div className="inspection-row"><span>Advisory</span><b>{selectedPFZ.properties.advisory_date ?? 'Unknown'}</b></div>
          {typeof selectedPFZ.properties.Length === 'number' && <div className="inspection-row"><span>Reported length*</span><b>{selectedPFZ.properties.Length.toFixed(1)}</b></div>}
          <small>*Source length units are not specified by this feed. Advisory only—not navigation guidance.{pfz?.metadata.stale ? ' Cached advisory; refresh unavailable.' : ''}</small>
        </section>
      )}

      {inspection && layer && !nearest && (
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
