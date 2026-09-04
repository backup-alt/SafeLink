import { memo, useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import { fieldToDataUrl, isLandAt } from './colors'
import type { Catalog, FieldData, Inspection, LayerMeta, NearestPFZ, OriginLocation, PFZFeature, PFZResponse } from './types'

interface OceanMapProps {
  field: FieldData | null
  layer: LayerMeta | null
  region: Catalog['region'] | null
  focusPoint: [number, number] | null
  onInspect: (inspection: Inspection | null) => void
  onHover: (inspection: Inspection | null, point?: { x: number; y: number }) => void
  pfz: PFZResponse | null
  pfzEnabled: boolean
  onPFZInspect: (feature: PFZFeature | null) => void
  onMapPoint: (point: [number, number]) => boolean
  nearestPFZ: NearestPFZ | null
  originLocation: OriginLocation | null
  pickingLocation: boolean
}

interface Particle {
  lng: number
  lat: number
  age: number
}

interface MapLabel {
  name: string
  lng: number
  lat: number
  minZoom: number
  rank: number
  kind: 'country' | 'city' | 'lake'
}

maplibregl.setWorkerUrl(maplibreWorkerUrl)

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'safelink-land': {
      type: 'geojson',
      data: '/indian-ocean-land.geojson',
      attribution: 'Ocean data © Copernicus Marine · boundaries © Natural Earth',
    },
    'safelink-lakes': {
      type: 'geojson',
      data: '/indian-ocean-lakes.geojson',
    },
  },
  layers: [
    {
      id: 'ocean-background',
      type: 'background',
      paint: { 'background-color': '#123b4b' },
    },
    {
      id: 'safelink-land-fill',
      type: 'fill',
      source: 'safelink-land',
      paint: {
        'fill-color': '#3c4446',
        'fill-opacity': 1,
      },
    },
    {
      id: 'safelink-lakes-fill',
      type: 'fill',
      source: 'safelink-lakes',
      paint: {
        'fill-color': '#155f78',
        'fill-opacity': .96,
      },
    },
    {
      id: 'safelink-lakes-outline',
      type: 'line',
      source: 'safelink-lakes',
      paint: {
        'line-color': '#237f98',
        'line-opacity': .9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, .35, 7, .8, 11, 1.2],
      },
    },
    {
      id: 'safelink-coastline-casing',
      type: 'line',
      source: 'safelink-land',
      paint: {
        'line-color': 'rgba(4, 12, 16, .78)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 7, 3.2, 11, 5],
      },
    },
    {
      id: 'safelink-coastline',
      type: 'line',
      source: 'safelink-land',
      paint: {
        'line-color': '#86989b',
        'line-opacity': .92,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, .55, 7, 1.2, 11, 1.8],
      },
    },
  ],
}

function nearestIndex(values: number[], target: number): number {
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  values.forEach((value, index) => {
    const candidate = Math.abs(value - target)
    if (candidate < distance) {
      best = index
      distance = candidate
    }
  })
  return best
}

export function inspectField(field: FieldData, lng: number, lat: number): Inspection | null {
  const x = nearestIndex(field.longitudes, lng)
  const y = nearestIndex(field.latitudes, lat)
  const value = field.values[y]?.[x]
  if (value === null || value === undefined) return null
  return {
    lng,
    lat,
    value,
    period: field.extras.period?.[y]?.[x],
    direction: field.extras.direction?.[y]?.[x],
  }
}

function vectorAt(field: FieldData, lng: number, lat: number): [number, number] | null {
  if (!field.u || !field.v) return null
  const xPosition = (lng - field.longitudes[0]) /
    (field.longitudes[field.longitudes.length - 1] - field.longitudes[0]) * (field.longitudes.length - 1)
  const yPosition = (lat - field.latitudes[0]) /
    (field.latitudes[field.latitudes.length - 1] - field.latitudes[0]) * (field.latitudes.length - 1)
  if (xPosition < 0 || yPosition < 0 || xPosition > field.longitudes.length - 1 || yPosition > field.latitudes.length - 1) return null
  const x0 = Math.floor(xPosition)
  const x1 = Math.min(field.longitudes.length - 1, x0 + 1)
  const y0 = Math.floor(yPosition)
  const y1 = Math.min(field.latitudes.length - 1, y0 + 1)
  const xMix = xPosition - x0
  const yMix = yPosition - y0
  const interpolate = (grid: (number | null)[][]) => {
    const samples = [
      [grid[y0]?.[x0], (1 - xMix) * (1 - yMix)],
      [grid[y0]?.[x1], xMix * (1 - yMix)],
      [grid[y1]?.[x0], (1 - xMix) * yMix],
      [grid[y1]?.[x1], xMix * yMix],
    ] as const
    let weighted = 0
    let weightTotal = 0
    samples.forEach(([value, weight]) => {
      if (value !== null && value !== undefined) {
        weighted += value * weight
        weightTotal += weight
      }
    })
    return weightTotal > 0 ? weighted / weightTotal : null
  }
  const u = interpolate(field.u)
  const v = interpolate(field.v)
  return u === null || v === null ? null : [u, v]
}

function randomParticle(field: FieldData, map: MapLibreMap): Particle {
  const bounds = map.getBounds()
  const minLng = Math.max(field.longitudes[0], bounds.getWest())
  const maxLng = Math.min(field.longitudes[field.longitudes.length - 1], bounds.getEast())
  const minLat = Math.max(field.latitudes[0], bounds.getSouth())
  const maxLat = Math.min(field.latitudes[field.latitudes.length - 1], bounds.getNorth())
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const particle = {
      lng: minLng + Math.random() * Math.max(0, maxLng - minLng),
      lat: minLat + Math.random() * Math.max(0, maxLat - minLat),
      age: Math.floor(Math.random() * 90),
    }
    if (!isLandAt(particle.lng, particle.lat) && vectorAt(field, particle.lng, particle.lat)) return particle
  }
  return { lng: minLng, lat: minLat, age: 90 }
}

function OceanMap({ field, layer, region, focusPoint, onInspect, onHover, pfz, pfzEnabled, onPFZInspect, onMapPoint, nearestPFZ, originLocation, pickingLocation }: OceanMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelCanvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  const userPositionedRef = useRef(false)
  const pickingLocationRef = useRef(pickingLocation)
  pickingLocationRef.current = pickingLocation
  const fieldRef = useRef(field)
  const layerRef = useRef(layer)
  const callbacksRef = useRef({ onInspect, onHover, onPFZInspect, onMapPoint })
  const pfzRef = useRef({ pfz, enabled: pfzEnabled })
  const pfzHoverRef = useRef<number | null>(null)

  fieldRef.current = field
  layerRef.current = layer
  callbacksRef.current = { onInspect, onHover, onPFZInspect, onMapPoint }
  pfzRef.current = { pfz, enabled: pfzEnabled }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [70, -14],
      zoom: 2.35,
      minZoom: 1.7,
      maxZoom: 11,
      maxBounds: [[10, -72], [132, 42]],
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    const addLandDetails = () => {
      if (map.getZoom() < 3.8 || !map.isStyleLoaded() || map.getSource('safelink-land-details')) return
      map.addSource('safelink-land-details', {
        type: 'geojson',
        data: '/indian-ocean-land-details.geojson',
      })
      map.addLayer({
        id: 'safelink-major-rivers',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 3.8,
        filter: ['all', ['==', ['get', 'kind'], 'river'], ['<=', ['get', 'rank'], 4]],
        paint: {
          'line-color': '#237e98',
          'line-opacity': .72,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, .55, 8, 1.15, 11, 1.8],
        },
      }, 'safelink-lakes-fill')
      map.addLayer({
        id: 'safelink-rivers',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 5.5,
        filter: ['all', ['==', ['get', 'kind'], 'river'], ['>', ['get', 'rank'], 4]],
        paint: {
          'line-color': '#27758b',
          'line-opacity': .55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5.5, .35, 9, .8, 11, 1.15],
        },
      }, 'safelink-lakes-fill')
      map.addLayer({
        id: 'safelink-roads-casing',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 6,
        filter: ['==', ['get', 'kind'], 'road'],
        paint: {
          'line-color': 'rgba(17, 23, 25, .68)',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, .35, 9, .6, 11, .72],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 9, 1.7, 11, 2.3],
        },
      }, 'safelink-lakes-fill')
      map.addLayer({
        id: 'safelink-roads',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 6,
        filter: ['==', ['get', 'kind'], 'road'],
        paint: {
          'line-color': '#9ea9a7',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, .45, 9, .65, 11, .75],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, .65, 9, 1, 11, 1.4],
        },
      }, 'safelink-lakes-fill')
      map.addLayer({
        id: 'safelink-state-boundaries',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 4.2,
        filter: ['==', ['get', 'kind'], 'state'],
        paint: {
          'line-color': 'rgba(174, 190, 191, .55)',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.2, .25, 7, .48, 11, .65],
          'line-width': ['interpolate', ['linear'], ['zoom'], 4.2, .35, 8, .7, 11, 1],
          'line-dasharray': [2, 2.4],
        },
      }, 'safelink-coastline-casing')
      map.addLayer({
        id: 'safelink-country-boundaries-casing',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 3.8,
        filter: ['==', ['get', 'kind'], 'country'],
        paint: {
          'line-color': 'rgba(7, 14, 17, .82)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3.8, 1.5, 8, 2.3, 11, 3],
        },
      }, 'safelink-coastline-casing')
      map.addLayer({
        id: 'safelink-country-boundaries',
        type: 'line',
        source: 'safelink-land-details',
        minzoom: 3.8,
        filter: ['==', ['get', 'kind'], 'country'],
        paint: {
          'line-color': 'rgba(180, 199, 201, .78)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3.8, .55, 8, .9, 11, 1.25],
        },
      }, 'safelink-coastline-casing')
    }
    map.on('zoomend', addLandDetails)
    map.once('load', addLandDetails)
    const pickPFZ = (event: MapMouseEvent) => {
      if (!pfzRef.current.enabled || !map.getLayer('pfz-line')) return null
      if (map.queryRenderedFeatures(event.point, { layers: ['safelink-land-fill'] }).length) return null
      const { x, y } = event.point
      const hit = map.queryRenderedFeatures([[x - 4, y - 4], [x + 4, y + 4]], { layers: ['pfz-line'] })[0]
      return hit ? pfzRef.current.pfz?.data.features.find((feature) => feature.id === hit.id) ?? null : null
    }
    const highlightPFZ = (id: number | null) => {
      if (pfzHoverRef.current === id) return
      if (pfzHoverRef.current !== null && map.getSource('pfz')) {
        map.setFeatureState({ source: 'pfz', id: pfzHoverRef.current }, { hover: false })
      }
      pfzHoverRef.current = id
      if (id !== null) map.setFeatureState({ source: 'pfz', id }, { hover: true })
      map.getCanvas().style.cursor = pickingLocationRef.current ? 'crosshair' : id === null ? '' : 'pointer'
    }
    let inspectionSequence = 0
    map.on('click', (event: MapMouseEvent) => {
      const sequence = ++inspectionSequence
      userPositionedRef.current = true
      if (callbacksRef.current.onMapPoint([((event.lngLat.lng + 180) % 360 + 360) % 360 - 180, event.lngLat.lat])) {
        callbacksRef.current.onInspect(null)
        callbacksRef.current.onHover(null)
        return
      }
      const advisory = pickPFZ(event)
      callbacksRef.current.onPFZInspect(advisory)
      if (advisory) {
        callbacksRef.current.onInspect(null)
        callbacksRef.current.onHover(null)
        return
      }
      if (isLandAt(event.lngLat.lng, event.lngLat.lat)) {
        callbacksRef.current.onInspect(null)
        return
      }
      const current = fieldRef.current
      if (!current) {
        callbacksRef.current.onInspect(null)
        return
      }
      const parameters = new URLSearchParams({
        latitude: String(event.lngLat.lat),
        longitude: String(event.lngLat.lng),
        time: current.time,
      })
      fetch(`/api/value/${current.layer}?${parameters}`)
        .then((response) => response.ok ? response.json() as Promise<Inspection> : Promise.reject())
        .then((inspection) => { if (sequence === inspectionSequence) callbacksRef.current.onInspect(inspection) })
        .catch(() => { if (sequence === inspectionSequence) callbacksRef.current.onInspect(inspectField(current, event.lngLat.lng, event.lngLat.lat)) })
    })
    let lastHover = 0
    map.on('mousemove', (event: MapMouseEvent) => {
      if (performance.now() - lastHover < 45) return
      lastHover = performance.now()
      const advisory = pickPFZ(event)
      highlightPFZ(advisory?.id ?? null)
      if (advisory) {
        callbacksRef.current.onHover(null)
        return
      }
      if (isLandAt(event.lngLat.lng, event.lngLat.lat)) {
        callbacksRef.current.onHover(null)
        return
      }
      const current = fieldRef.current
      const inspection = current ? inspectField(current, event.lngLat.lng, event.lngLat.lat) : null
      callbacksRef.current.onHover(inspection, event.point)
    })
    map.on('mouseout', () => { highlightPFZ(null); callbacksRef.current.onHover(null) })
    mapRef.current = map
    return () => {
      inspectionSequence += 1
      map.off('zoomend', addLandDetails)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !pfz) return
    const apply = () => {
      if (!map.getLayer('safelink-land-fill')) return
      const source = map.getSource('pfz') as maplibregl.GeoJSONSource | undefined
      if (source) {
        map.removeFeatureState({ source: 'pfz' })
        pfzHoverRef.current = null
        map.getCanvas().style.cursor = ''
        source.setData(pfz.data)
        return
      }
      map.addSource('pfz', { type: 'geojson', data: pfz.data, attribution: 'PFZ advisories © INCOIS' })
      const visibility = pfzRef.current.enabled ? 'visible' : 'none'
      map.addLayer({
        id: 'pfz-casing', type: 'line', source: 'pfz',
        layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#142128', 'line-opacity': .95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 4.5, 6, 6, 11, 9] },
      }, 'safelink-land-fill')
      map.addLayer({
        id: 'pfz-line', type: 'line', source: 'pfz',
        layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffffff', '#ffd166'],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            2, ['case', ['boolean', ['feature-state', 'hover'], false], 3.5, 2],
            6, ['case', ['boolean', ['feature-state', 'hover'], false], 4.5, 3],
            11, ['case', ['boolean', ['feature-state', 'hover'], false], 7, 5]] },
      }, 'safelink-land-fill')
    }
    apply()
    map.on('style.load', apply)
    return () => { map.off('style.load', apply) }
  }, [pfz?.data])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    for (const id of ['pfz-casing', 'pfz-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', pfzEnabled ? 'visible' : 'none')
    }
    if (!pfzEnabled && map.getSource('pfz')) {
      map.removeFeatureState({ source: 'pfz' })
      pfzHoverRef.current = null
      map.getCanvas().style.cursor = ''
    }
  }, [pfzEnabled, pfz?.data])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const data = { type: 'FeatureCollection' as const, features: nearestPFZ ? [
      nearestPFZ.feature,
      ...[nearestPFZ.origin, nearestPFZ.point].map((p, index) => ({
        type: 'Feature' as const, properties: { origin: index === 0 },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      })),
    ] : [] }
    const apply = () => {
      if (!map.getLayer('safelink-land-fill')) return
      const source = map.getSource('nearest-pfz') as maplibregl.GeoJSONSource | undefined
      if (source) {
        source.setData(data)
        map.moveLayer('nearest-pfz-highlight', 'safelink-land-fill')
        return
      }
      map.addSource('nearest-pfz', { type: 'geojson', data })
      map.addLayer({ id: 'nearest-pfz-highlight', type: 'line', source: 'nearest-pfz',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3, 11, 7] },
      }, 'safelink-land-fill')
      map.addLayer({ id: 'nearest-pfz-points', type: 'circle', source: 'nearest-pfz',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': ['case', ['get', 'origin'], '#ffffff', '#ffd166'],
          'circle-stroke-color': '#142128', 'circle-stroke-width': 2 },
      })
    }
    apply()
    map.on('style.load', apply)
    return () => { map.off('style.load', apply) }
  }, [nearestPFZ, pfz?.data])

  useEffect(() => {
    const canvas = labelCanvasRef.current
    const map = mapRef.current
    if (!canvas || !map) return
    const context = canvas.getContext('2d')
    if (!context) return
    let labels: MapLabel[] = []
    let animationFrame = 0
    let disposed = false

    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      context.clearRect(0, 0, rect.width, rect.height)
      const zoom = map.getZoom()
      const bounds = map.getBounds()
      const kindOrder = { country: 0, lake: 1, city: 2 }
      const visible = labels
        .filter((label) => label.minZoom <= zoom && !(label.kind === 'country' && zoom > 6.5)
          && label.lng >= bounds.getWest() - 2 && label.lng <= bounds.getEast() + 2
          && label.lat >= bounds.getSouth() - 2 && label.lat <= bounds.getNorth() + 2)
        .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.rank - b.rank)
      const occupied: { left: number; top: number; right: number; bottom: number }[] = []

      for (const label of visible) {
        const point = map.project([label.lng, label.lat])
        if (point.x < -80 || point.y < -20 || point.x > rect.width + 80 || point.y > rect.height + 20) continue
        const country = label.kind === 'country'
        const lake = label.kind === 'lake'
        const size = country ? Math.min(14, 10.5 + zoom * .55) : lake ? 10 : Math.min(12, 9 + zoom * .35)
        context.font = `${lake ? 'italic ' : ''}${country ? '700' : '600'} ${size}px Manrope, Inter, sans-serif`
        const name = country ? label.name.toLocaleUpperCase('en') : label.name
        const dotOffset = label.kind === 'city' ? 7 : 0
        const width = context.measureText(name).width + dotOffset
        const candidate = {
          left: point.x - width / 2 - 4,
          top: point.y - size / 2 - 4,
          right: point.x + width / 2 + 4,
          bottom: point.y + size / 2 + 4,
        }
        if (occupied.some((box) => candidate.left < box.right && candidate.right > box.left
          && candidate.top < box.bottom && candidate.bottom > box.top)) continue
        occupied.push(candidate)

        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.lineJoin = 'round'
        context.lineWidth = country ? 3.5 : 3
        context.strokeStyle = 'rgba(11, 20, 24, .9)'
        context.fillStyle = country ? 'rgba(226, 237, 238, .78)'
          : lake ? 'rgba(126, 211, 229, .9)' : 'rgba(235, 242, 243, .9)'
        context.strokeText(name, point.x + dotOffset / 2, point.y)
        context.fillText(name, point.x + dotOffset / 2, point.y)
        if (label.kind === 'city') {
          context.beginPath()
          context.arc(point.x - width / 2 + 1, point.y, 1.7, 0, Math.PI * 2)
          context.fillStyle = 'rgba(224, 240, 242, .92)'
          context.fill()
        }
      }
    }
    const scheduleDraw = () => {
      if (animationFrame) return
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0
        draw()
      })
    }
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.round(rect.width * ratio)
      canvas.height = Math.round(rect.height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      scheduleDraw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    map.on('move', scheduleDraw)
    fetch('/indian-ocean-labels.json')
      .then((response) => response.ok ? response.json() as Promise<MapLabel[]> : Promise.reject())
      .then((data) => {
        if (!disposed) {
          labels = data
          scheduleDraw()
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      map.off('move', scheduleDraw)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !region || userPositionedRef.current) return
    map.setMaxBounds([
      [region.minimum_longitude - 8, Math.max(-82, region.minimum_latitude - 10)],
      [region.maximum_longitude + 8, Math.min(82, region.maximum_latitude + 10)],
    ])
    map.fitBounds([
      [region.minimum_longitude, region.minimum_latitude],
      [region.maximum_longitude, region.maximum_latitude],
    ], { padding: { top: 86, right: 225, bottom: 116, left: 24 }, duration: 0 })
  }, [
    region?.minimum_longitude,
    region?.maximum_longitude,
    region?.minimum_latitude,
    region?.maximum_latitude,
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !field || !layer) return
    let cancelled = false
    const longitudeStep = field.longitudes.length > 1 ? Math.abs(field.longitudes[1] - field.longitudes[0]) : 0
    const latitudeStep = field.latitudes.length > 1 ? Math.abs(field.latitudes[1] - field.latitudes[0]) : 0
    const minLng = field.longitudes[0] - longitudeStep / 2
    const maxLng = field.longitudes[field.longitudes.length - 1] + longitudeStep / 2
    const minLat = field.latitudes[0] - latitudeStep / 2
    const maxLat = field.latitudes[field.latitudes.length - 1] + latitudeStep / 2
    const coordinates: maplibregl.Coordinates = [
      [minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat],
    ]
    const apply = async () => {
      const url = await fieldToDataUrl(
        field.values,
        field.latitudes,
        field.longitudes,
        layer.domain,
        layer.palette,
        layer.logarithmic,
      )
      if (cancelled) return
      const source = map.getSource('ocean-field') as maplibregl.ImageSource | undefined
      if (source) source.updateImage({ url, coordinates })
      else {
        map.addSource('ocean-field', { type: 'image', url, coordinates })
        map.addLayer({
          id: 'ocean-field',
          type: 'raster',
          source: 'ocean-field',
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 180, 'raster-resampling': 'linear' },
        }, map.getLayer('pfz-casing') ? 'pfz-casing' : 'safelink-land-fill')
      }
    }
    if (map.isStyleLoaded()) void apply()
    else map.once('load', () => void apply())
    return () => { cancelled = true }
  }, [field, layer])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusPoint) return
    userPositionedRef.current = true
    map.setMaxBounds(null)
    map.flyTo({ center: focusPoint, zoom: Math.max(map.getZoom(), 7), duration: 900 })
    markerRef.current?.remove()
    const element = document.createElement('div')
    element.className = 'coordinate-marker'
    markerRef.current = new maplibregl.Marker({ element }).setLngLat(focusPoint).addTo(map)
  }, [focusPoint])

  useEffect(() => {
    const map = mapRef.current
    if (map) map.getCanvas().style.cursor = pickingLocation ? 'crosshair' : ''
  }, [pickingLocation])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !originLocation) return
    userPositionedRef.current = true
    markerRef.current?.remove()
    const element = document.createElement('div')
    element.className = 'origin-location-marker'
    const label = document.createElement('span')
    label.textContent = originLocation.source === 'device' ? 'Your device location' : 'Starting location'
    element.appendChild(label)
    const marker = new maplibregl.Marker({ element }).setLngLat(originLocation.point).addTo(map)
    return () => { marker.remove() }
  }, [originLocation])

  useEffect(() => {
    const canvas = canvasRef.current
    const map = mapRef.current
    if (!canvas || !map || !field?.u || !field.v) return
    const context = canvas.getContext('2d')
    if (!context) return
    let animationFrame = 0
    let particles: Particle[] = []

    const seedParticles = () => {
      const rect = canvas.getBoundingClientRect()
      const count = Math.min(650, Math.max(260, Math.round(rect.width * rect.height / 2600)))
      particles = Array.from({ length: count }, () => randomParticle(field, map))
    }

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.round(rect.width * ratio)
      canvas.height = Math.round(rect.height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      seedParticles()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    map.on('moveend', seedParticles)

    let previous = performance.now()
    const draw = (now: number) => {
      if (now - previous < 30) {
        animationFrame = requestAnimationFrame(draw)
        return
      }
      const delta = Math.min(2, (now - previous) / 16.67)
      previous = now
      const rect = canvas.getBoundingClientRect()
      context.globalCompositeOperation = 'destination-in'
      context.fillStyle = 'rgba(0, 0, 0, 0.82)'
      context.fillRect(0, 0, rect.width, rect.height)
      context.globalCompositeOperation = 'source-over'
      context.strokeStyle = layerRef.current?.id === 'waves' ? 'rgba(236,244,255,.82)' : 'rgba(121,246,240,.82)'
      context.lineWidth = 1.2
      context.beginPath()
      particles.forEach((particle, index) => {
        const vector = vectorAt(field, particle.lng, particle.lat)
        if (!vector || isLandAt(particle.lng, particle.lat) || particle.age > 110) {
          particles[index] = randomParticle(field, map)
          return
        }
        const start = map.project([particle.lng, particle.lat])
        const factor = field.layer === 'waves' ? 0.003 : 0.01
        particle.lng += vector[0] * factor * delta
        particle.lat += vector[1] * factor * delta
        particle.age += delta
        const end = map.project([particle.lng, particle.lat])
        if (end.x < 0 || end.y < 0 || end.x > rect.width || end.y > rect.height) {
          particles[index] = randomParticle(field, map)
          return
        }
        context.moveTo(start.x, start.y)
        context.lineTo(end.x, end.y)
      })
      context.stroke()
      animationFrame = requestAnimationFrame(draw)
    }
    animationFrame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      map.off('moveend', seedParticles)
      context.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [field])

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map" />
      <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />
      <canvas ref={labelCanvasRef} className="label-canvas" aria-hidden="true" />
    </div>
  )
}

export default memo(OceanMap)
