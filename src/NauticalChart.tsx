import { memo, useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

const SEAMAP_STYLE = 'https://tiles.openwaters.io/seamap/style.json'

interface NauticalChartProps {
  center: [number, number]
  zoom: number
  onCenterChange: (center: [number, number], zoom: number) => void
  focusPoint: [number, number] | null
  onMapClick?: (point: [number, number]) => void
  route: { type: string; geometry: { type: string; coordinates: [number, number][] }; properties: Record<string, unknown> } | null
  alternatives: { type: string; geometry: { type: string; coordinates: [number, number][] }; properties: Record<string, unknown> }[]
  selectedRouteIndex: number
  origin: [number, number] | null
  destination: [number, number] | null
  picking: 'origin' | 'destination' | 'waypoint' | null
  waypoints: [number, number][]
  distanceLabels: { position: [number, number]; distance_km: number }[]
  vessels: import('./types').Vessel[]
  onVesselSelect: (vessel: import('./types').Vessel | null) => void
  weatherPoints: { position: [number, number]; waves: number | null; current: number | null }[]
}

function NauticalChart({ center, zoom, onCenterChange, focusPoint, onMapClick, route, alternatives, selectedRouteIndex, origin, destination, picking, waypoints, distanceLabels, vessels, onVesselSelect, weatherPoints }: NauticalChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  const originMarkerRef = useRef<maplibregl.Marker | null>(null)
  const destMarkerRef = useRef<maplibregl.Marker | null>(null)
  const waypointMarkersRef = useRef<maplibregl.Marker[]>([])
  const distanceLabelMarkersRef = useRef<maplibregl.Marker[]>([])
  const weatherMarkersRef = useRef<maplibregl.Marker[]>([])
  const callbacksRef = useRef({ onMapClick, onCenterChange, onVesselSelect })
  callbacksRef.current = { onMapClick, onCenterChange, onVesselSelect }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SEAMAP_STYLE,
      center,
      zoom,
      minZoom: 2,
      maxZoom: 18,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')

    map.on('moveend', () => {
      const c = map.getCenter()
      callbacksRef.current.onCenterChange([c.lng, c.lat], map.getZoom())
    })

    map.on('click', (event: MapMouseEvent) => {
      if (callbacksRef.current.onMapClick) {
        callbacksRef.current.onMapClick([event.lngLat.lng, event.lngLat.lat])
      }
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusPoint) return
    map.flyTo({ center: focusPoint, zoom: Math.max(map.getZoom(), 7), duration: 900 })
    markerRef.current?.remove()
    const el = document.createElement('div')
    el.className = 'coordinate-marker'
    markerRef.current = new maplibregl.Marker({ element: el }).setLngLat(focusPoint).addTo(map)
  }, [focusPoint])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const el = document.createElement('div')
    el.className = 'nav-origin-marker'
    originMarkerRef.current?.remove()
    if (origin) {
      originMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(origin).addTo(map)
    }
    return () => { originMarkerRef.current?.remove() }
  }, [origin])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const el = document.createElement('div')
    el.className = 'nav-dest-marker'
    destMarkerRef.current?.remove()
    if (destination) {
      destMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(destination).addTo(map)
    }
    return () => { destMarkerRef.current?.remove() }
  }, [destination])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    waypointMarkersRef.current.forEach((m) => m.remove())
    waypointMarkersRef.current = []
    waypoints.forEach((wp) => {
      const el = document.createElement('div')
      el.className = 'nav-waypoint-marker'
      const marker = new maplibregl.Marker({ element: el }).setLngLat(wp).addTo(map)
      waypointMarkersRef.current.push(marker)
    })
    return () => { waypointMarkersRef.current.forEach((m) => m.remove()); waypointMarkersRef.current = [] }
  }, [waypoints])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    distanceLabelMarkersRef.current.forEach((m) => m.remove())
    distanceLabelMarkersRef.current = []
    distanceLabels.forEach((label) => {
      const el = document.createElement('div')
      el.className = 'nav-distance-label'
      el.textContent = `${label.distance_km.toFixed(0)} km`
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' })
        .setLngLat(label.position)
        .addTo(map)
      distanceLabelMarkersRef.current.push(marker)
    })
    return () => { distanceLabelMarkersRef.current.forEach((m) => m.remove()); distanceLabelMarkersRef.current = [] }
  }, [distanceLabels])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const routeColors = ['#5cf2ed', '#ffd166', '#7ec8e3']
    const apply = () => {
      for (let idx = 0; idx < 3; idx++) {
        const srcId = `nav-route-${idx}`
        const casingId = `nav-route-casing-${idx}`
        const lineId = `nav-route-line-${idx}`
        const existing = map.getSource(srcId)
        if (existing) map.removeSource(srcId)
        if (map.getLayer(lineId)) map.removeLayer(lineId)
        if (map.getLayer(casingId)) map.removeLayer(casingId)
      }
      alternatives.forEach((r, idx) => {
        const srcId = `nav-route-${idx}`
        const casingId = `nav-route-casing-${idx}`
        const lineId = `nav-route-line-${idx}`
        const isActive = idx === selectedRouteIndex
        map.addSource(srcId, { type: 'geojson', data: r })
        map.addLayer({
          id: casingId,
          type: 'line',
          source: srcId,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#0e171b',
            'line-width': isActive ? ['interpolate', ['linear'], ['zoom'], 2, 5, 11, 11] : ['interpolate', ['linear'], ['zoom'], 2, 2, 11, 4],
            'line-opacity': isActive ? 1 : 0.5,
          },
        })
        map.addLayer({
          id: lineId,
          type: 'line',
          source: srcId,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': routeColors[idx] || '#5cf2ed',
            'line-width': isActive ? ['interpolate', ['linear'], ['zoom'], 2, 3, 11, 7] : ['interpolate', ['linear'], ['zoom'], 2, 1, 11, 3],
            'line-opacity': isActive ? 1 : 0.4,
          },
        })
      })
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
    return () => {
      for (let idx = 0; idx < 3; idx++) {
        const lineId = `nav-route-line-${idx}`
        const casingId = `nav-route-casing-${idx}`
        const srcId = `nav-route-${idx}`
        if (map.getLayer(lineId)) map.removeLayer(lineId)
        if (map.getLayer(casingId)) map.removeLayer(casingId)
        if (map.getSource(srcId)) map.removeSource(srcId)
      }
    }
  }, [alternatives, selectedRouteIndex])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.getCanvas().style.cursor = picking ? 'crosshair' : ''
  }, [picking])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const features = {
      type: 'FeatureCollection',
      features: vessels.map((v) => ({
        type: 'Feature',
        properties: { mmsi: v.mmsi, name: v.name || v.mmsi, course: v.course },
        geometry: { type: 'Point', coordinates: [v.longitude, v.latitude] },
      })),
    }
    const source = map.getSource('nautical-vessels') as maplibregl.GeoJSONSource | undefined
    if (source) {
      source.setData(features)
    } else {
      map.addSource('nautical-vessels', { type: 'geojson', data: features })
      map.addLayer({
        id: 'nautical-vessel-markers',
        type: 'symbol',
        source: 'nautical-vessels',
        layout: {
          'icon-image': 'triangle-11',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 12, 1.1],
          'icon-rotate': ['get', 'course'],
          'icon-allow-overlap': true,
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-size': 9,
        },
        paint: {
          'text-color': '#edf6f7',
          'text-halo-color': '#0e171b',
          'text-halo-width': 1.5,
          'icon-color': '#5cf2ed',
        },
      })
      map.on('click', 'nautical-vessel-markers', (e) => {
        if (!e.features?.length) return
        const props = e.features[0].properties
        const vessel = vessels.find((v) => v.mmsi === props?.mmsi)
        if (vessel) callbacksRef.current.onVesselSelect(vessel)
      })
      map.on('mouseenter', 'nautical-vessel-markers', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'nautical-vessel-markers', () => { map.getCanvas().style.cursor = picking ? 'crosshair' : '' })
    }
  }, [vessels])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    weatherMarkersRef.current.forEach((m) => m.remove())
    weatherMarkersRef.current = []
    weatherPoints.forEach((wp) => {
      const el = document.createElement('div')
      el.className = 'nav-weather-marker'
      const waveText = wp.waves !== null ? `${wp.waves.toFixed(1)}m` : '--'
      const currText = wp.current !== null ? `${wp.current.toFixed(1)}kn` : '--'
      el.innerHTML = `<div class="weather-waves">${waveText}</div><div class="weather-current">${currText}</div>`
      const color = (wp.waves ?? 0) > 3 ? '#ff756f' : (wp.waves ?? 0) > 2 ? '#ffd166' : '#5cf2ed'
      el.style.borderColor = color
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(wp.position)
        .addTo(map)
      weatherMarkersRef.current.push(marker)
    })
    return () => { weatherMarkersRef.current.forEach((m) => m.remove()); weatherMarkersRef.current = [] }
  }, [weatherPoints])

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map" />
      <small className="nautical-attribution">Nautical chart data: OpenStreetMap contributors, Seascape bathymetry. Advisory only — not certified navigation.</small>
    </div>
  )
}

export default memo(NauticalChart)
