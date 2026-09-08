import { memo, useCallback, useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { Search } from 'lucide-react'
import { fetchVessels } from './api'
import type { Vessel } from './types'
import {
  VESSEL_TYPES,
  VESSEL_TYPE_COLORS,
  VESSEL_TYPE_DEFAULT_COLOR,
  VESSEL_TYPE_FILTERS,
} from './types'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.versatiles.org/assets/fonts/{fontstack}/{range}.pbf',
  sources: {
    'safelink-land': {
      type: 'geojson',
      data: '/indian-ocean-land.geojson',
      attribution: 'Land data © Natural Earth',
    },
  },
  layers: [
    { id: 'ocean-background', type: 'background', paint: { 'background-color': '#0a1520' } },
    { id: 'land-fill', type: 'fill', source: 'safelink-land', paint: { 'fill-color': '#1a2530', 'fill-opacity': 1 } },
    { id: 'coastline', type: 'line', source: 'safelink-land', paint: { 'line-color': '#2a3a45', 'line-width': 1 } },
  ],
}

const TYPE_COLOR_MATCH: maplibregl.ExpressionSpecification = [
  'match', ['get', 'type'],
  '30', VESSEL_TYPE_COLORS['30'],
  '40', VESSEL_TYPE_COLORS['40'],
  '50', VESSEL_TYPE_COLORS['50'],
  '60', VESSEL_TYPE_COLORS['60'],
  '70', VESSEL_TYPE_COLORS['70'],
  '80', VESSEL_TYPE_COLORS['80'],
  '90', VESSEL_TYPE_COLORS['90'],
  VESSEL_TYPE_DEFAULT_COLOR,
]

const NAV_STATUS_LABELS: Record<string, string> = {
  '0': 'Under way', '1': 'At anchor', '2': 'Not under command',
  '3': 'Restricted', '4': 'Constrained', '5': 'Moored',
  '6': 'Aground', '7': 'Fishing', '8': 'Sailing',
}

interface VesselFinderProps {
  center: [number, number]
  zoom: number
  onCenterChange: (center: [number, number], zoom: number) => void
  onVesselSelect: (vessel: Vessel | null) => void
  selectedVessel: Vessel | null
}

function vesselTypeLabel(code: string): string {
  return VESSEL_TYPES[code] || `Type ${code}`
}

function buildVesselFeatures(vessels: Vessel[]): { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: Record<string, unknown> }> } {
  return {
    type: 'FeatureCollection',
    features: vessels.map((v) => ({
      type: 'Feature',
      properties: {
        mmsi: v.mmsi,
        name: v.name || v.mmsi,
        course: v.course,
        type: v.type,
        speed: v.speed,
        navStatus: v.navStatus,
      },
      geometry: {
        type: 'Point',
        coordinates: [v.longitude, v.latitude],
      },
    })),
  }
}

function VesselFinder({ center, zoom, onCenterChange, onVesselSelect, selectedVessel }: VesselFinderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const layersCreatedRef = useRef(false)
  const mapLoadedRef = useRef(false)
  const [vessels, setVessels] = useState<Vessel[]>([])
  const [aisError, setAisError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [liveStatus, setLiveStatus] = useState<'idle' | 'live' | 'error'>('idle')
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const callbacksRef = useRef({ onVesselSelect })
  callbacksRef.current = { onVesselSelect }

  const typeFilterRef = useRef(typeFilter)
  typeFilterRef.current = typeFilter
  const searchRef = useRef(searchQuery)
  searchRef.current = searchQuery
  const vesselsRef = useRef(vessels)
  vesselsRef.current = vessels
  const selectedMmsiRef = useRef(selectedVessel?.mmsi ?? null)
  selectedMmsiRef.current = selectedVessel?.mmsi ?? null

  const applyFilters = useCallback(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return

    const tf = typeFilterRef.current
    const sq = searchRef.current.trim().toLowerCase()
    const vs = vesselsRef.current

    const filters: maplibregl.FilterSpecification[] = []

    if (tf !== 'all') {
      filters.push(['==', ['get', 'type'], tf])
    }

    if (sq) {
      const matches = vs
        .filter((v) => v.name.toLowerCase().includes(sq) || v.mmsi.includes(sq))
        .map((v) => v.mmsi)
      if (matches.length > 0) {
        filters.push(['in', ['get', 'mmsi'], ['literal', matches]])
      } else {
        filters.push(['==', ['get', 'mmsi'], '__none__'])
      }
    }

    const combined =
      filters.length === 0
        ? (['boolean', true] as maplibregl.FilterSpecification)
        : filters.length === 1
          ? filters[0]
          : (['all', ...filters] as maplibregl.FilterSpecification)

    for (const layerId of ['vessel-markers', 'vessel-marker-labels']) {
      try { map.setFilter(layerId, combined) } catch { /* layer may not exist yet */ }
    }
  }, [])

  useEffect(() => {
    applyFilters()
  }, [searchQuery, typeFilter, vessels, applyFilters])

  useEffect(() => {
    applyFilters()
  }, [selectedVessel, applyFilters])

  const addLayers = useCallback((map: MapLibreMap, data: { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: Record<string, unknown> }> }) => {
    if (layersCreatedRef.current) return

    if (!map.hasImage('vessel-arrow')) {
      const s = 11
      const canvas = document.createElement('canvas')
      canvas.width = s
      canvas.height = s
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, s, s)
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(s / 2, 0)
      ctx.lineTo(s, s)
      ctx.lineTo(s / 2, s * 0.7)
      ctx.lineTo(0, s)
      ctx.closePath()
      ctx.fill()
      map.addImage('vessel-arrow', { width: s, height: s, data: ctx.getImageData(0, 0, s, s).data })
    }

    map.addSource('vessels', {
      type: 'geojson',
      data,
      cluster: true,
      clusterMaxZoom: 10,
      clusterRadius: 50,
    })

    map.addLayer({
      id: 'vessel-clusters',
      type: 'circle',
      source: 'vessels',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': [
          'step', ['get', 'point_count'],
          'rgba(92, 242, 237, 0.3)',
          10, 'rgba(92, 242, 237, 0.5)',
          50, 'rgba(92, 242, 237, 0.7)',
        ],
        'circle-radius': [
          'step', ['get', 'point_count'],
          15, 10, 20, 50, 28,
        ],
        'circle-stroke-color': '#5cf2ed',
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.6,
      },
    })

    map.addLayer({
      id: 'vessel-cluster-count',
      type: 'symbol',
      source: 'vessels',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': '{point_count_abbreviated}',
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-size': 11,
      },
      paint: {
        'text-color': '#edf6f7',
        'text-halo-color': '#0a1520',
        'text-halo-width': 1,
      },
    })

    map.addLayer({
      id: 'vessel-markers',
      type: 'symbol',
      source: 'vessels',
      filter: ['!', ['has', 'point_count']],
      layout: {
          'icon-image': 'vessel-arrow',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 12, 1.3],
        'icon-rotate': ['get', 'course'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': TYPE_COLOR_MATCH,
      },
    })

    map.addLayer({
      id: 'vessel-marker-labels',
      type: 'symbol',
      source: 'vessels',
      filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'name'], ['get', 'mmsi']]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-size': 10,
      },
      paint: {
        'text-color': '#edf6f7',
        'text-halo-color': '#0a1520',
        'text-halo-width': 1.5,
        'text-opacity': [
          'interpolate', ['linear'], ['zoom'],
          6, 0,
          8, 0.4,
          10, 1,
        ],
      },
    })

    map.addLayer({
      id: 'vessel-selected-ring',
      type: 'circle',
      source: 'vessels',
      filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'mmsi'], '']],
      paint: {
        'circle-radius': 14,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#ffd166',
        'circle-stroke-width': 2.5,
        'circle-stroke-opacity': 0.9,
      },
    })

    map.on('click', 'vessel-clusters', async (e) => {
      const feats = map.queryRenderedFeatures(e.point, { layers: ['vessel-clusters'] })
      if (!feats?.length) return
      const clusterId = feats[0].properties?.cluster_id
      if (clusterId == null) return
      const src = map.getSource('vessels') as maplibregl.GeoJSONSource
      try {
        const zoom = await src.getClusterExpansionZoom(clusterId)
        const geom = feats[0].geometry as { type: 'Point'; coordinates: [number, number] }
        map.easeTo({ center: geom.coordinates, zoom: Math.min(zoom, 14) })
      } catch { /* ignore */ }
    })

    map.on('click', 'vessel-markers', (e) => {
      if (!e.features?.length) return
      const props = e.features[0].properties
      const vessel = vesselsRef.current.find((v) => v.mmsi === props?.mmsi)
      if (vessel) callbacksRef.current.onVesselSelect(vessel)
    })

    map.on('mouseenter', 'vessel-markers', (e) => {
      map.getCanvas().style.cursor = 'pointer'
      if (!e.features?.length) return
      const props = e.features[0].properties
      const geom = e.features[0].geometry as { type: 'Point'; coordinates: [number, number] }
      const coords = geom.coordinates
      const typeName = vesselTypeLabel(props?.type || '')
      const typeColor = VESSEL_TYPE_COLORS[props?.type || ''] || VESSEL_TYPE_DEFAULT_COLOR
      const speed = typeof props?.speed === 'number' ? props.speed.toFixed(1) : '0.0'
      const status = NAV_STATUS_LABELS[props?.navStatus] || ''
      const html = `<div class="vessel-tooltip">
        <div class="tt-name">${props?.name || 'Unknown'}</div>
        <span class="tt-type" style="background:${typeColor}22;color:${typeColor}">${typeName}</span>
        <div class="tt-row"><span class="tt-label">Speed</span><span class="tt-value">${speed} kn</span></div>
        ${status ? `<div class="tt-row"><span class="tt-label">Status</span><span class="tt-value">${status}</span></div>` : ''}
      </div>`
      popupRef.current?.remove()
      popupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 14,
        className: 'vessel-popup',
      })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map)
    })

    map.on('mouseleave', 'vessel-markers', () => {
      map.getCanvas().style.cursor = ''
      popupRef.current?.remove()
      popupRef.current = null
    })

    map.on('mouseenter', 'vessel-clusters', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'vessel-clusters', () => { map.getCanvas().style.cursor = '' })

    layersCreatedRef.current = true
  }, [])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DARK_STYLE,
      center,
      zoom,
      minZoom: 2,
      maxZoom: 14,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')

    map.on('moveend', () => {
      const c = map.getCenter()
      onCenterChange([c.lng, c.lat], map.getZoom())
    })

    map.on('load', () => {
      mapLoadedRef.current = true
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; layersCreatedRef.current = false; mapLoadedRef.current = false }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let active = true
    const loadVessels = () => {
      setLoading(true)
      const bounds = map.getBounds()
      fetchVessels({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      }).then((data) => {
        if (active) { setVessels(data); setAisError(false); setLoading(false); setLiveStatus('live') }
      }).catch(() => {
        if (active) { setAisError(true); setLoading(false); setLiveStatus('error') }
      })
    }
    loadVessels()
    const interval = setInterval(loadVessels, 30000)
    map.on('moveend', loadVessels)
    return () => { active = false; clearInterval(interval); map.off('moveend', loadVessels) }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const features = buildVesselFeatures(vessels)

    if (layersCreatedRef.current) {
      const source = map.getSource('vessels') as maplibregl.GeoJSONSource | undefined
      if (source) {
        source.setData(features)
      }
      return
    }

    const create = () => { addLayers(map, features) }
    if (mapLoadedRef.current) create()
    else map.once('load', create)
  }, [vessels, addLayers])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !layersCreatedRef.current) return
    const sel = selectedMmsiRef.current || ''
    try {
      map.setFilter('vessel-selected-ring', ['all', ['!', ['has', 'point_count']], ['==', ['get', 'mmsi'], sel]])
    } catch { /* layer may not exist yet */ }
  }, [selectedVessel])

  useEffect(() => {
    const timer = setTimeout(() => { if (liveStatus === 'live') setLiveStatus('idle') }, 5000)
    return () => clearTimeout(timer)
  }, [liveStatus])

  const displayedCount = vessels.length
  const q = searchQuery.trim().toLowerCase()
  const searchActive = q.length > 0
  const searchResultCount = searchActive
    ? vessels.filter((v) => v.name.toLowerCase().includes(q) || v.mmsi.includes(q)).length
    : 0

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map" />

      {loading && <div className="vessel-loading" />}

      {aisError && <div className="ais-unavailable glass">AIS data unavailable — retrying</div>}

      {!aisError && liveStatus === 'live' && (
        <div className="vessel-live glass">
          <span className="vessel-live-dot" /> LIVE AIS
        </div>
      )}

      <div className="vessel-search glass">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search name or MMSI..."
          aria-label="Search vessels by name or MMSI"
        />
        {searchActive && (
          <button
            type="button"
            className="search-clear"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
        <button type="button" aria-label="Search"><Search size={15} /></button>
      </div>

      <div className="vessel-type-filter">
        {VESSEL_TYPE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`vessel-type-pill ${typeFilter === f.key ? 'active' : ''}`}
            onClick={() => setTypeFilter(f.key)}
          >
            {f.key !== 'all' && (
              <span
                className="pill-dot"
                style={{ background: VESSEL_TYPE_COLORS[f.key] || VESSEL_TYPE_DEFAULT_COLOR }}
              />
            )}
            {f.label}
          </button>
        ))}
      </div>

      <div className="vessel-count glass">
        <span className="count-num">{searchActive ? searchResultCount : displayedCount}</span>
        {searchActive ? 'results' : 'vessels'}
      </div>

      <div className="vessel-legend glass">
        <div className="legend-title">AIS VESSELS</div>
        {VESSEL_TYPE_FILTERS.filter((f) => f.key !== 'all').map((f) => (
          <div key={f.key} className="legend-item">
            <span className="legend-dot" style={{ background: VESSEL_TYPE_COLORS[f.key] || VESSEL_TYPE_DEFAULT_COLOR }} />
            {f.label}
          </div>
        ))}
      </div>

      <small className="vessel-attribution">
        Vessel data: Open Waters AIS aggregator (near-real-time, terrestrial receivers)
      </small>
    </div>
  )
}

export default memo(VesselFinder)
