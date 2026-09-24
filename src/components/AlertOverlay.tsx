import { useEffect, useRef } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'

interface Props {
  map: MapLibreMap | null
  geofenceEnabled: boolean
  weatherEnabled: boolean
}

export default function AlertOverlay({ map, geofenceEnabled, weatherEnabled }: Props) {
  const flashRef = useRef<number | null>(null)

  useEffect(() => {
    if (!map) return
    let cancelled = false

    const add = async () => {
      if (!map.isStyleLoaded()) { map.once('load', add); return }
      // geofences
      try {
        const res = await fetch('/api/geofences')
        const data = await res.json()
        if (cancelled) return
        if (map.getSource('guard-geofence')) (map.getSource('guard-geofence') as any).setData(data)
        else {
          map.addSource('guard-geofence', { type: 'geojson', data })
          map.addLayer({ id: 'guard-geofence-fill', type: 'fill', source: 'guard-geofence', paint: { 'fill-color': '#ff3b30', 'fill-opacity': 0.22 } }, 'safelink-land-fill')
          map.addLayer({ id: 'guard-geofence-line', type: 'line', source: 'guard-geofence', paint: { 'line-color': '#ff3b30', 'line-width': 2, 'line-dasharray': [2,2] } })
        }
      } catch {}
      // weather hazards
      try {
        const res = await fetch('/api/alerts/weather')
        const data = await res.json()
        if (cancelled) return
        if (map.getSource('guard-weather')) (map.getSource('guard-weather') as any).setData(data)
        else {
          map.addSource('guard-weather', { type: 'geojson', data })
          map.addLayer({ id: 'guard-weather-fill', type: 'fill', source: 'guard-weather', paint: { 'fill-color': ['case', ['==', ['get','severity'],'danger'], '#ff0000', '#ffcc00'], 'fill-opacity': 0.35 } }, 'safelink-land-fill')
          map.addLayer({ id: 'guard-weather-line', type: 'line', source: 'guard-weather', paint: { 'line-color': '#ff0000', 'line-width': 2 } })
        }
      } catch {}
    }
    add()
    // flashing
    let on = false
    flashRef.current = window.setInterval(() => {
      if (!map.getLayer('guard-weather-fill')) return
      on = !on
      map.setPaintProperty('guard-weather-fill', 'fill-opacity', on ? 0.55 : 0.25)
    }, 600)
    return () => { cancelled = true; if (flashRef.current) clearInterval(flashRef.current) }
  }, [map])

  useEffect(() => {
    if (!map) return
    for (const id of ['guard-geofence-fill','guard-geofence-line']) if (map.getLayer(id)) map.setLayoutProperty(id,'visibility', geofenceEnabled?'visible':'none')
  }, [map, geofenceEnabled])

  useEffect(() => {
    if (!map) return
    for (const id of ['guard-weather-fill','guard-weather-line']) if (map.getLayer(id)) map.setLayoutProperty(id,'visibility', weatherEnabled?'visible':'none')
  }, [map, weatherEnabled])

  return null
}
