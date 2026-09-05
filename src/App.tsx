import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ChevronDown, ChevronLeft, ChevronRight, Clock3, Droplets, Info,
  Layers3, LoaderCircle, Menu, Navigation2, Pause, Play, Search, Thermometer, Waves, X,
} from 'lucide-react'
import { fetchCatalog, fetchCondition, fetchField, fetchNearestPFZ, fetchPFZ, fetchNauticalClick, fetchNauticalPoint, fetchRoute, fetchVessels, prefetchField, searchPlaces } from './api'
import OceanMap from './OceanMap'
import ChatPanel from './ChatPanel'
import { isMapAction } from './chatTypes'
import NauticalChart from './NauticalChart'
import VesselFinder from './VesselFinder'
import VesselDetails from './VesselDetails'
import MapViewSwitcher from './MapViewSwitcher'
import NavigationPanel from './NavigationPanel'
import type { MapAction, MapContext } from './chatTypes'
import type { Catalog, ConditionSample, FieldData, GeocodeResult, Inspection, LayerId, LayerMeta, MapView, NauticalPointDetails, NavRoute, NearestPFZ, OriginLocation, PFZFeature, PFZResponse, SavedNavRoute, Vessel } from './types'

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
  const [clickedLocation, setClickedLocation] = useState<MapContext['clicked_location']>(null)
  const [mapContext, setMapContext] = useState<{ center: MapContext['center']; zoom: number }>({ center: null, zoom: 4 })
  const [mapCommand, setMapCommand] = useState<{ id: number; action: MapAction } | null>(null)
  const layerRef = useRef<LayerId>(selectedLayer)
  layerRef.current = selectedLayer
  const updateMapContext = useCallback((view: { center: MapContext['center']; zoom: number }) => setMapContext(view), [])
  const [nearestOrigin, setNearestOrigin] = useState<[number, number] | null>(null)
  const [nearest, setNearest] = useState<NearestPFZ | null>(null)
  const [nearestLoading, setNearestLoading] = useState(false)
  const [nearestError, setNearestError] = useState<string | null>(null)
  const [conditions, setConditions] = useState<Partial<Record<LayerId, ConditionSample | null>>>({})
  const [locationStep, setLocationStep] = useState<'choose' | 'map' | 'locating' | 'confirm' | null>('choose')
  const [originLocation, setOriginLocation] = useState<OriginLocation | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [locationPurpose, setLocationPurpose] = useState<'pfz' | 'chat'>('chat')
  const locationRequest = useRef(0)
  const locationHeading = useRef<HTMLHeadingElement>(null)

  const [mapView, setMapView] = useState<MapView>('ocean')
  const [mapCenter, setMapCenter] = useState<[number, number]>([75, 10])
  const [mapZoom, setMapZoom] = useState(4)
  const [navOrigin, setNavOrigin] = useState<[number, number] | null>(null)
  const [navDestination, setNavDestination] = useState<[number, number] | null>(null)
  const [navRoute, setNavRoute] = useState<NavRoute | null>(null)
  const [navRouteAlternatives, setNavRouteAlternatives] = useState<NavRoute[]>([])
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0)
  const [navLoading, setNavLoading] = useState(false)
  const [navPointLoading, setNavPointLoading] = useState<'origin' | 'destination' | null>(null)
  const [selectedVessel, setSelectedVessel] = useState<Vessel | null>(null)
  const [navPicking, setNavPicking] = useState<'origin' | 'destination' | 'waypoint' | null>(null)
  const [nauticalInfo, setNauticalInfo] = useState<{ coordinates: { lng: number; lat: number }; conditions: Record<string, { value: number; unit: string; time: string } | null> } | null>(null)
  const [navWaypoints, setNavWaypoints] = useState<[number, number][]>([])
  const [navSpeed, setNavSpeed] = useState(10)
  const [navError, setNavError] = useState<string | null>(null)
  const [navRouteMode, setNavRouteMode] = useState<'auto' | 'manual' | null>(null)
  const [navOriginDetails, setNavOriginDetails] = useState<NauticalPointDetails | null>(null)
  const [navDestinationDetails, setNavDestinationDetails] = useState<NauticalPointDetails | null>(null)
  const [savedNavRoutes, setSavedNavRoutes] = useState<SavedNavRoute[]>([])
  const [navGeocodeResults, setNavGeocodeResults] = useState<GeocodeResult[]>([])
  const [navGeocodeTarget, setNavGeocodeTarget] = useState<'origin' | 'destination' | null>(null)
  const [navGeocodeLoading, setNavGeocodeLoading] = useState(false)
  const [nauticalVessels, setNauticalVessels] = useState<Vessel[]>([])
  const [showWeatherOverlay, setShowWeatherOverlay] = useState(false)
  const [weatherPoints, setWeatherPoints] = useState<{ position: [number, number]; waves: number | null; current: number | null }[]>([])

  useEffect(() => {
    if (mapView !== 'nautical') return
    let active = true
    const load = () => {
      const [lng, lat] = mapCenter
      const half = 5 / Math.pow(2, mapZoom - 4)
      fetchVessels({
        west: lng - half, south: lat - half,
        east: lng + half, north: lat + half,
      }).then((data) => { if (active) setNauticalVessels(data) }).catch(() => {})
    }
    load()
    const interval = setInterval(load, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [mapView, mapCenter[0], mapCenter[1], Math.round(mapZoom)])

  useEffect(() => {
    if (!showWeatherOverlay || !navRoute || mapView !== 'nautical') { setWeatherPoints([]); return }
    let active = true
    const coords = navRoute.coordinates
    const step = Math.max(1, Math.floor(coords.length / 8))
    const samplePoints = coords.filter((_, i) => i % step === 0 || i === coords.length - 1)
    Promise.all(samplePoints.map(async (pos) => {
      try {
        const detail = await fetchNauticalPoint(pos)
        return {
          position: pos,
          waves: detail.wave_height?.value ?? null,
          current: detail.current?.value ?? null,
        }
      } catch {
        return { position: pos, waves: null, current: null }
      }
    })).then((points) => { if (active) setWeatherPoints(points) })
    return () => { active = false }
  }, [showWeatherOverlay, navRoute, mapView])

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
    setLocationPurpose('pfz')
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
    setClickedLocation({ longitude: point[0], latitude: point[1] })
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
    layerRef.current = id
    const next = catalog?.layers.find((candidate) => candidate.id === id)
    setSelectedLayer(id)
    setTimeIndex(nearestTimeIndex(next?.times ?? []))
    setInspection(null)
    setHover(null)
    setField(null)
    setPlaying(false)
  }

  const applyChatAction = async (action: MapAction, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    if (!isMapAction(action)) throw new Error('Unsupported map action')
    setPlaying(false)
    switch (action.type) {
      case 'select_layer': {
        if (!catalog?.layers.find(x => x.id === action.layer)?.available) throw new Error('Layer unavailable')
        setMapView('ocean')
        chooseLayer(action.layer)
        return `Showing ${action.layer.replace('_', ' ')}`
      }
      case 'set_time': {
        const available = catalog?.layers.find(x => x.id === layerRef.current)?.times ?? []
        if (!available.length) throw new Error('Timeline unavailable')
        const target = Date.parse(action.time)
        const index = available.reduce((best, time, i) => Math.abs(Date.parse(time) - target) < Math.abs(Date.parse(available[best]) - target) ? i : best, 0)
        setTimeIndex(index)
        return `Map time: ${available[index]} (nearest available)`
      }
      case 'highlight_pfz': {
        const data = await fetchPFZ(signal)
        signal.throwIfAborted()
        const feature = data.data.features.find(x => String(x.properties.Sno) === action.pfz_id)
        if (!feature) throw new Error('PFZ no longer available')
        setPFZ(data); setPFZEnabled(true); setSelectedPFZ(feature); setNearestOrigin(null); setInspection(null)
        return `Highlighted INCOIS PFZ ${action.pfz_id}`
      }
      case 'clear_map_highlights':
        setSelectedPFZ(null); setNearestOrigin(null); setInspection(null)
        setMapCommand({ id: Date.now(), action })
        return 'Cleared assistant map highlights'
      case 'request_location':
        setMapView('ocean')
        openLocationPicker()
        setLocationPurpose('chat')
        return 'Location chooser opened. Choose and confirm a position, then send your next message.'
      case 'zoom_in': case 'zoom_out':
        setMapView('ocean')
        if (!mapContext.center) return 'Map view is not ready yet'
        setMapCommand({ id: Date.now(), action: { type: 'fly_to', ...mapContext.center,
          zoom: Math.max(2, Math.min(14, mapContext.zoom + (action.type === 'zoom_in' ? 1 : -1))) } })
        return action.type === 'zoom_in' ? 'Zoomed in one level' : 'Zoomed out one level'
      case 'fly_to': case 'place_marker':
        setMapView('ocean')
        setMapCommand({ id: Date.now(), action })
        return action.type === 'fly_to' ? 'Moved map to the requested point' : 'Placed a map marker'
    }
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

  const handleMapViewChange = useCallback((view: MapView) => {
    setMapView(view)
    setInspection(null)
    setHover(null)
    setSelectedPFZ(null)
    setSelectedVessel(null)
    setNauticalInfo(null)
    setNavPicking(null)
    setNavError(null)
    setNavWaypoints([])
    setNavSpeed(10)
    setShowWeatherOverlay(false)
    setWeatherPoints([])
  }, [])

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('safelink.nav.routes') || '[]') as SavedNavRoute[]
      if (Array.isArray(saved)) setSavedNavRoutes(saved)
    } catch {
      setSavedNavRoutes([])
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('safelink.nav.routes', JSON.stringify(savedNavRoutes))
  }, [savedNavRoutes])

  const handleMapContextChange = useCallback((center: [number, number], zoom: number) => {
    setMapCenter(center)
    setMapZoom(zoom)
  }, [])

  const loadNauticalDetails = useCallback(async (type: 'origin' | 'destination', point: [number, number]) => {
    const controller = new AbortController()
    setNavPointLoading(type)
    try {
      const details = await fetchNauticalPoint(point, controller.signal)
      if (type === 'origin') setNavOriginDetails(details)
      else setNavDestinationDetails(details)
    } catch {
      if (type === 'origin') setNavOriginDetails(null)
      else setNavDestinationDetails(null)
      setNavError('Marine point data is unavailable for that position.')
    } finally {
      setNavPointLoading((current) => current === type ? null : current)
    }
  }, [])

  const setNavigationPoint = useCallback((type: 'origin' | 'destination', point: [number, number]) => {
    if (type === 'origin') {
      setNavOrigin(point)
      setNavOriginDetails(null)
    } else {
      setNavDestination(point)
      setNavDestinationDetails(null)
    }
    setFocusPoint(point)
    setNavRoute(null)
    setNavRouteMode(null)
    setNavPicking(null)
    setNavGeocodeResults([])
    setNavGeocodeTarget(null)
    setNavError(null)
    void loadNauticalDetails(type, point)
  }, [loadNauticalDetails])

  const handleNavCurrentLocation = useCallback(() => {
    setNavError(null)
    if (!window.isSecureContext || !navigator.geolocation) {
      setNavError('Device location is unavailable here. Use localhost/HTTPS or select the origin on the map.')
      return
    }
    setNavPointLoading('origin')
    navigator.geolocation.getCurrentPosition((position) => {
      const point: [number, number] = [position.coords.longitude, position.coords.latitude]
      setNavigationPoint('origin', point)
    }, () => {
      setNavPointLoading(null)
      setNavError('Could not read device location. Select the origin on the map or search coordinates.')
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
  }, [setNavigationPoint])

  const handleNavSearchPoint = useCallback(async (type: 'origin' | 'destination', value: string) => {
    const queryText = value.trim()
    if (!queryText) return
    const coordinates = parseCoordinates(queryText)
    if (coordinates) {
      setNavigationPoint(type, coordinates)
      return
    }
    setNavGeocodeTarget(type)
    setNavGeocodeLoading(true)
    setNavError(null)
    try {
      const results = await searchPlaces(queryText)
      setNavGeocodeResults(results)
      if (!results.length) setNavError('No matching location found. Try coordinates or a clearer place name.')
    } catch {
      setNavGeocodeResults([])
      setNavError('Location search is unavailable right now.')
    } finally {
      setNavGeocodeLoading(false)
    }
  }, [setNavigationPoint])

  const handleUseGeocode = useCallback((type: 'origin' | 'destination', result: GeocodeResult) => {
    setNavigationPoint(type, [result.longitude, result.latitude])
  }, [setNavigationPoint])

  const handleNauticalClick = useCallback(async (point: [number, number]) => {
    if (navPicking === 'origin') { setNavigationPoint('origin', point); return }
    if (navPicking === 'destination') { setNavigationPoint('destination', point); return }
    if (navPicking === 'waypoint') {
      setNavWaypoints((prev) => [...prev, point])
      setNavRoute(null)
      setNavPicking(null)
      setNavError(null)
      return
    }
    setNavError(null)
    try {
      const result = await fetchNauticalClick(point[0], point[1])
      setNauticalInfo(result)
    } catch { setNauticalInfo(null); setNavError('Failed to fetch marine conditions. Is the backend running?') }
  }, [navPicking, setNavigationPoint])

  const handleCalculateRoute = useCallback(async () => {
    if (!navOrigin || !navDestination) return
    setNavLoading(true)
    setNavError(null)
    try {
      const result = await fetchRoute(navOrigin, navDestination, navWaypoints, navSpeed)
      const alternatives = result.alternatives ?? []
      setNavRouteAlternatives(alternatives)
      setSelectedRouteIndex(0)
      setNavRoute(alternatives[0] ?? null)
    } catch { setNavError('Route calculation failed. Check that the backend supports POST requests.') }
    finally { setNavLoading(false) }
  }, [navOrigin, navDestination, navWaypoints, navSpeed])

  const handleRouteMode = useCallback((mode: 'auto' | 'manual') => {
    setNavRouteMode(mode)
    setNavRoute(null)
    setNavError(null)
    if (mode === 'auto') {
      setNavPicking(null)
      setShowWeatherOverlay(true)
      window.setTimeout(() => void handleCalculateRoute(), 0)
    } else {
      setNavPicking('waypoint')
    }
  }, [handleCalculateRoute])

  const handleSaveRoute = useCallback(() => {
    if (!navRoute || !navOrigin || !navDestination) return
    const saved: SavedNavRoute = {
      id: `${Date.now()}`,
      name: `${navOrigin[1].toFixed(2)}, ${navOrigin[0].toFixed(2)} to ${navDestination[1].toFixed(2)}, ${navDestination[0].toFixed(2)}`,
      savedAt: new Date().toISOString(),
      origin: navOrigin,
      destination: navDestination,
      waypoints: navWaypoints,
      speed_knots: navSpeed,
      distance_km: navRoute.distance_km,
      eta_hours: navRoute.eta_hours,
      heading: navRoute.heading,
      route: navRoute,
      originDetails: navOriginDetails,
      destinationDetails: navDestinationDetails,
    }
    setSavedNavRoutes((previous) => [saved, ...previous].slice(0, 12))
  }, [navDestination, navDestinationDetails, navOrigin, navOriginDetails, navRoute, navSpeed, navWaypoints])

  const handleLoadSavedRoute = useCallback((saved: SavedNavRoute) => {
    setNavOrigin(saved.origin)
    setNavDestination(saved.destination)
    setNavWaypoints(saved.waypoints)
    setNavSpeed(saved.speed_knots)
    setNavRoute(saved.route)
    setNavRouteMode('auto')
    setNavOriginDetails(saved.originDetails)
    setNavDestinationDetails(saved.destinationDetails)
    setFocusPoint(saved.origin)
    setShowWeatherOverlay(true)
    setNavError(null)
  }, [])

  const handleClearRoute = useCallback(() => {
    setNavRoute(null)
    setNavRouteAlternatives([])
    setSelectedRouteIndex(0)
    setNavOrigin(null)
    setNavDestination(null)
    setNavOriginDetails(null)
    setNavDestinationDetails(null)
    setNavWaypoints([])
    setNavRouteMode(null)
    setNavPicking(null)
    setNavGeocodeResults([])
    setNavGeocodeTarget(null)
  }, [])

  const handleSelectRoute = useCallback((index: number) => {
    setSelectedRouteIndex(index)
    setNavRoute(navRouteAlternatives[index] ?? null)
  }, [navRouteAlternatives])

  return (
    <main className="app-shell">
      {mapView === 'ocean' && (
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
          selectedPFZId={pfzEnabled ? selectedPFZ?.id ?? null : null}
          onViewChange={updateMapContext}
          mapCommand={mapCommand}
        />
      )}
      {mapView === 'nautical' && (
        <NauticalChart
          center={mapCenter}
          zoom={mapZoom}
          onCenterChange={handleMapContextChange}
          focusPoint={focusPoint}
          onMapClick={handleNauticalClick}
          route={navRoute ? { type: 'Feature', geometry: { type: 'LineString', coordinates: navRoute.coordinates }, properties: {} } : null}
          alternatives={navRouteAlternatives.map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coordinates }, properties: { label: r.label } }))}
          selectedRouteIndex={selectedRouteIndex}
          origin={navOrigin}
          destination={navDestination}
          picking={navPicking}
          waypoints={navWaypoints}
          distanceLabels={navRoute?.distance_labels ?? []}
          vessels={nauticalVessels}
          onVesselSelect={setSelectedVessel}
          weatherPoints={showWeatherOverlay ? weatherPoints : []}
        />
      )}
      {mapView === 'vessels' && (
        <VesselFinder
          center={mapCenter}
          zoom={mapZoom}
          onCenterChange={handleMapContextChange}
          onVesselSelect={setSelectedVessel}
        />
      )}

      <header className="topbar glass">
        <button className="menu-button" type="button" aria-label="Menu"><Menu size={22} /></button>
        <div className="brand"><span className="brand-mark">S</span><div><b>SAFE<span>LINK</span></b><small>OCEAN CONDITIONS</small></div></div>
        <MapViewSwitcher current={mapView} onChange={handleMapViewChange} />
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

      {mapView === 'ocean' && catalog && <LayerRail layers={catalog.layers} selected={selectedLayer} onSelect={chooseLayer} />}
      {mapView === 'ocean' && (
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
      )}
      {mapView === 'ocean' && layer && <Legend layer={layer} />}

      {mapView === 'ocean' && <ChatPanel context={{ ...mapContext, clicked_location: locationStep ? null : clickedLocation,
        active_layer: selectedLayer, selected_pfz: selectedPFZ ? String(selectedPFZ.properties.Sno ?? '') : nearest ? String(nearest.feature.properties.Sno ?? '') : null,
        selected_time: selectedTime ?? null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }} onMapAction={applyChatAction} />}

      {mapView === 'ocean' && locationStep && <section className="location-picker glass" aria-labelledby="location-heading">
        <button className="location-close" type="button" onClick={cancelLocation} aria-label="Cancel location selection"><X size={17} /></button>
        <h2 id="location-heading" tabIndex={-1} ref={locationHeading}>Where are you starting from?</h2>
        <p>{locationPurpose === 'chat' ? 'SafeLink is asking for a starting point. Choose your device location or a map point, confirm it, then send your next chat message to share it with the assistant.' : 'Select your current or departure location—not a destination. We’ll find the nearest PFZ from there.'}</p>
        <div className="location-actions">
          <button className="nearest-pfz-button" type="button" disabled={locationStep === 'locating'} onClick={locateDevice}>
            {locationStep === 'locating' ? 'Finding your location…' : 'Use my current location'}
          </button>
          <button className="nearest-pfz-button" type="button" onClick={() => {
            locationRequest.current += 1; setLocationStep('map'); setLocationError(null); setOriginLocation(null)
          }}>Choose on map</button>
          <button className="nearest-pfz-button" type="button" onClick={cancelLocation}>Continue without location</button>
        </div>
        <p role="status">{locationStep === 'map' ? 'Click your starting position anywhere on the map. You can also enter coordinates in the search bar.'
          : locationStep === 'locating' ? 'Allow the browser\'s location request. You can select a map point instead at any time.'
          : locationStep === 'confirm' ? 'Check the marked position, then confirm below. Click another map point to adjust it.'
          : 'Use device location, or click your starting point on the map.'}</p>
        {locationError && <p role="alert" className="location-error">{locationError}</p>}
        {originLocation && locationStep === 'confirm' && <div className="location-confirm">
          <strong>{originLocation.source === 'device' ? 'Device-reported location' : 'Selected starting location'}</strong>
          <p>{originLocation.point[1].toFixed(5)}°, {originLocation.point[0].toFixed(5)}°</p>
          {originLocation.accuracy !== undefined && <p>Reported accuracy: approximately {Math.round(originLocation.accuracy).toLocaleString()} m.
            {originLocation.accuracy > 1000 ? ' This is a coarse location—check the marker carefully or select your position manually.' : ' Check the marker before continuing.'}</p>}
          <button className="nearest-pfz-button" type="button" onClick={() => {
            setLocationStep(null); setPlaying(false)
            setClickedLocation({ latitude: originLocation.point[1], longitude: originLocation.point[0] })
            if (locationPurpose === 'pfz') setNearestOrigin([...originLocation.point])
          }}>{locationPurpose === 'chat' ? 'Use this point for my next message' : 'Find PFZ from this location'}</button>
        </div>}
        <small>Location access is optional. If it is switched off or denied, SafeLink cannot determine your actual location. No continuous tracking.</small>
      </section>}

      {mapView === 'ocean' && nearest && pfzEnabled && (
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

      {mapView === 'ocean' && selectedPFZ && pfzEnabled && !nearest && (
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

      {mapView === 'ocean' && inspection && layer && !nearest && (
        <section className="inspection-card glass">
          <button type="button" onClick={() => setInspection(null)} aria-label="Close values"><X size={16} /></button>
          <div className="inspection-time"><Clock3 size={15} />{field ? formatTime(field.time) : ''}</div>
          <div className="inspection-location">{inspection.lat.toFixed(3)}°N · {inspection.lng.toFixed(3)}°E</div>
          <div className="inspection-primary"><span>{layer.label}</span><strong>{inspection.value.toFixed(2)} <small>{layer.unit}</small></strong></div>
          {inspection.period != null && <div className="inspection-row"><span>Period</span><b>{inspection.period.toFixed(1)} s</b></div>}
          {inspection.direction != null && <div className="inspection-row"><span>Direction</span><b>{Math.round(inspection.direction)}°</b></div>}
        </section>
      )}

      {mapView === 'ocean' && hover && layer && (
        <div className="hover-value" style={{ left: hover.x + 16, top: hover.y + 82 }}>
          {hover.inspection.value.toFixed(2)} {layer.unit}
        </div>
      )}

      {mapView === 'ocean' && times.length > 0 && (
        <Timeline times={times} index={timeIndex} playing={playing} onIndex={setTimeIndex} onPlaying={setPlaying} />
      )}

      {mapView === 'ocean' && loading && <div className="loading-pill glass"><LoaderCircle className="spin" size={18} /> Loading ocean data</div>}
      {mapView === 'ocean' && error && <div className="error-banner">{error}. Make sure the SafeLink backend is running on port 8000.</div>}

      {mapView === 'nautical' && (
        <NavigationPanel
          origin={navOrigin}
          destination={navDestination}
          originDetails={navOriginDetails}
          destinationDetails={navDestinationDetails}
          route={navRoute}
          alternatives={navRouteAlternatives}
          selectedRouteIndex={selectedRouteIndex}
          loading={navLoading}
          pointLoading={navPointLoading}
          picking={navPicking}
          routeMode={navRouteMode}
          savedRoutes={savedNavRoutes}
          geocodeResults={navGeocodeTarget ? navGeocodeResults : []}
          geocodeTarget={navGeocodeTarget}
          geocodeLoading={navGeocodeLoading}
          onUseCurrentLocation={handleNavCurrentLocation}
          onPickOnMap={(type) => setNavPicking(type)}
          onSearchPoint={handleNavSearchPoint}
          onUseGeocode={handleUseGeocode}
          onSetRouteMode={handleRouteMode}
          onCalculate={handleCalculateRoute}
          onSelectRoute={handleSelectRoute}
          onSaveRoute={handleSaveRoute}
          onLoadRoute={handleLoadSavedRoute}
          onDeleteSavedRoute={(id) => setSavedNavRoutes((previous) => previous.filter((saved) => saved.id !== id))}
          onClear={handleClearRoute}
          onClose={() => { handleClearRoute(); setNavSpeed(10); setShowWeatherOverlay(false); setWeatherPoints([]) }}
          waypoints={navWaypoints}
          onAddWaypoint={() => setNavPicking('waypoint')}
          onRemoveWaypoint={(idx) => { setNavWaypoints((prev) => prev.filter((_, i) => i !== idx)); setNavRoute(null) }}
          speed={navSpeed}
          onSpeedChange={setNavSpeed}
          showWeather={showWeatherOverlay}
          onWeatherToggle={() => setShowWeatherOverlay((v) => !v)}
        />
      )}

      {mapView === 'nautical' && nauticalInfo && (
        <section className="nautical-info-card glass" aria-label="Marine conditions at selected point">
          <button type="button" onClick={() => setNauticalInfo(null)} aria-label="Close"><X size={16} /></button>
          <div className="inspection-time">Marine Conditions</div>
          <div className="inspection-location">{nauticalInfo.coordinates.lat.toFixed(3)}°N · {nauticalInfo.coordinates.lng.toFixed(3)}°E</div>
          {Object.entries(nauticalInfo.conditions).map(([key, val]) => (
            <div className="inspection-row" key={key}>
              <span>{key.charAt(0).toUpperCase() + key.slice(1).replace('_', ' ')}</span>
              <b>{val ? `${val.value.toFixed(2)} ${val.unit}` : 'Unavailable'}</b>
            </div>
          ))}
          <small>Copernicus nearest-grid samples at this location. Not navigation advice.</small>
        </section>
      )}

      {mapView === 'vessels' && selectedVessel && (
        <VesselDetails vessel={selectedVessel} onClose={() => setSelectedVessel(null)} />
      )}

      {mapView === 'nautical' && navError && (
        <div className="error-banner" onClick={() => setNavError(null)} style={{ cursor: 'pointer' }}>
          {navError}
        </div>
      )}

      <footer className="attribution-footer">
        Data: Copernicus Marine + INCOIS. Route is advisory demo only — not certified for navigation. Always verify with official charts.
      </footer>
    </main>
  )
}
