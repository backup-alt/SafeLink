import { memo, useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { fetchVessels } from './api'
import type { Vessel } from './types'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
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

interface VesselFinderProps {
  center: [number, number]
  zoom: number
  onCenterChange: (center: [number, number], zoom: number) => void
  onVesselSelect: (vessel: Vessel | null) => void
}

function VesselFinder({ center, zoom, onCenterChange, onVesselSelect }: VesselFinderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [vessels, setVessels] = useState<Vessel[]>([])
  const [aisError, setAisError] = useState(false)
  const callbacksRef = useRef({ onVesselSelect })
  callbacksRef.current = { onVesselSelect }

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

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let active = true
    const loadVessels = () => {
      const bounds = map.getBounds()
      fetchVessels({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      }).then((data) => {
        if (active) { setVessels(data); setAisError(false) }
      }).catch(() => {
        if (active) setAisError(true)
      })
    }
    loadVessels()
    const interval = setInterval(loadVessels, 30000)
    map.on('moveend', loadVessels)
    return () => { active = false; clearInterval(interval); map.off('moveend', loadVessels) }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const features: { type: string; features: Array<{ type: string; geometry: { type: string; coordinates: [number, number] }; properties: Record<string, unknown> }> } = {
      type: 'FeatureCollection',
      features: vessels.map((v) => ({
        type: 'Feature',
        properties: {
          mmsi: v.mmsi,
          name: v.name || v.mmsi,
          course: v.course,
        },
        geometry: {
          type: 'Point',
          coordinates: [v.longitude, v.latitude],
        },
      })),
    }
    const source = map.getSource('vessels') as maplibregl.GeoJSONSource | undefined
    if (source) {
      source.setData(features)
    } else {
      map.addSource('vessels', { type: 'geojson', data: features })
      map.addLayer({
        id: 'vessel-markers',
        type: 'symbol',
        source: 'vessels',
        layout: {
          'icon-image': 'triangle-11',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 12, 1.3],
          'icon-rotate': ['get', 'course'],
          'icon-allow-overlap': true,
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
          'icon-color': '#5cf2ed',
        },
      })
      map.on('click', 'vessel-markers', (e) => {
        if (!e.features?.length) return
        const props = e.features[0].properties
        const vessel = vessels.find((v) => v.mmsi === props?.mmsi)
        if (vessel) callbacksRef.current.onVesselSelect(vessel)
      })
      map.on('mouseenter', 'vessel-markers', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'vessel-markers', () => { map.getCanvas().style.cursor = '' })
    }
  }, [vessels])

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map" />
      {aisError && <div className="ais-unavailable glass">AIS data unavailable — retrying</div>}
      <small className="vessel-attribution">Vessel data: Open Waters AIS aggregator (near-real-time, terrestrial receivers)</small>
    </div>
  )
}

export default memo(VesselFinder)
