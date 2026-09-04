import { memo, useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import { fieldToDataUrl, isLandAt } from './colors'
import type { Catalog, FieldData, Inspection, LayerMeta } from './types'

interface OceanMapProps {
  field: FieldData | null
  layer: LayerMeta | null
  region: Catalog['region'] | null
  focusPoint: [number, number] | null
  onInspect: (inspection: Inspection | null) => void
  onHover: (inspection: Inspection | null, point?: { x: number; y: number }) => void
}

interface Particle {
  lng: number
  lat: number
  age: number
}

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'safelink-land': {
      type: 'geojson',
      data: '/indian-ocean-land.geojson',
      attribution: 'Ocean data © Copernicus Marine · boundaries © Natural Earth',
    },
    'safelink-land-mask': {
      type: 'image',
      url: '/indian-ocean-land-overlay.png',
      coordinates: [[20, 30], [120, 30], [120, -60], [20, -60]],
    },
  },
  layers: [
    {
      id: 'ocean-background',
      type: 'background',
      paint: { 'background-color': '#123b4b' },
    },
    {
      id: 'safelink-land-mask',
      type: 'raster',
      source: 'safelink-land-mask',
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
        'raster-resampling': 'linear',
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

function OceanMap({ field, layer, region, focusPoint, onInspect, onHover }: OceanMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  const fieldRef = useRef(field)
  const layerRef = useRef(layer)
  const callbacksRef = useRef({ onInspect, onHover })

  fieldRef.current = field
  layerRef.current = layer
  callbacksRef.current = { onInspect, onHover }

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
    map.on('click', (event: MapMouseEvent) => {
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
        .then((inspection) => callbacksRef.current.onInspect(inspection))
        .catch(() => callbacksRef.current.onInspect(inspectField(current, event.lngLat.lng, event.lngLat.lat)))
    })
    let lastHover = 0
    map.on('mousemove', (event: MapMouseEvent) => {
      if (performance.now() - lastHover < 45) return
      lastHover = performance.now()
      if (isLandAt(event.lngLat.lng, event.lngLat.lat)) {
        callbacksRef.current.onHover(null)
        return
      }
      const current = fieldRef.current
      const inspection = current ? inspectField(current, event.lngLat.lng, event.lngLat.lat) : null
      callbacksRef.current.onHover(inspection, event.point)
    })
    map.on('mouseout', () => callbacksRef.current.onHover(null))
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !region) return
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
        }, 'safelink-land-mask')
      }
    }
    if (map.isStyleLoaded()) void apply()
    else map.once('load', () => void apply())
    return () => { cancelled = true }
  }, [field, layer])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusPoint) return
    map.flyTo({ center: focusPoint, zoom: Math.max(map.getZoom(), 7), duration: 900 })
    markerRef.current?.remove()
    const element = document.createElement('div')
    element.className = 'coordinate-marker'
    markerRef.current = new maplibregl.Marker({ element }).setLngLat(focusPoint).addTo(map)
  }, [focusPoint])

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
    </div>
  )
}

export default memo(OceanMap)
