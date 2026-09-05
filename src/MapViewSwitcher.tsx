import { Anchor, Map, Ship } from 'lucide-react'
import type { MapView } from './types'

const VIEWS: { id: MapView; label: string; icon: typeof Map }[] = [
  { id: 'ocean', label: 'Ocean Map', icon: Map },
  { id: 'nautical', label: 'Nautical', icon: Anchor },
  { id: 'vessels', label: 'Vessels', icon: Ship },
]

export default function MapViewSwitcher({ current, onChange }: {
  current: MapView
  onChange: (view: MapView) => void
}) {
  return (
    <nav className="map-view-switcher" aria-label="Map views">
      {VIEWS.map((view) => {
        const Icon = view.icon
        return (
          <button
            key={view.id}
            type="button"
            className={`map-view-button ${current === view.id ? 'active' : ''}`}
            onClick={() => onChange(view.id)}
          >
            <Icon size={14} />
            <span>{view.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
