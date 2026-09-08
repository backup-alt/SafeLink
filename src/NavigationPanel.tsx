import { useCallback, useRef } from 'react'
import { AlertTriangle, Compass, Crosshair, Download, Flag, History, LocateFixed, MapPin, Navigation2, Route, Save, Search, ShipWheel, Trash2, Upload, X } from 'lucide-react'
import type { GeocodeResult, NauticalPointDetails, NavRoute, RouteGroupResponse, SavedNavRoute } from './types'

type NavPickTarget = 'origin' | 'destination' | 'waypoint' | null
type RouteMode = 'auto' | 'manual' | null
type NavStep = 1 | 2 | 3 | 4

interface NavigationPanelProps {
  origin: [number, number] | null
  destination: [number, number] | null
  originDetails: NauticalPointDetails | null
  destinationDetails: NauticalPointDetails | null
  route: NavRoute | null
  alternatives: NavRoute[]
  selectedRouteIndex: number
  routeGroupMeta: { safest: RouteGroupResponse; direct: RouteGroupResponse } | null
  loading: boolean
  pointLoading: 'origin' | 'destination' | null
  picking: NavPickTarget
  routeMode: RouteMode
  waypoints: [number, number][]
  speed: number
  showWeather: boolean
  savedRoutes: SavedNavRoute[]
  geocodeResults: GeocodeResult[]
  geocodeTarget: 'origin' | 'destination' | null
  geocodeLoading: boolean
  onUseCurrentLocation: () => void
  onPickOnMap: (type: Exclude<NavPickTarget, null>) => void
  onSearchPoint: (type: 'origin' | 'destination', query: string) => void
  onUseGeocode: (type: 'origin' | 'destination', result: GeocodeResult) => void
  onSetRouteMode: (mode: Exclude<RouteMode, null>) => void
  onCalculate: () => void
  onSelectRoute: (index: number) => void
  onSaveRoute: () => void
  onLoadRoute: (route: SavedNavRoute) => void
  onDeleteSavedRoute: (id: string) => void
  onClear: () => void
  onClose: () => void
  onAddWaypoint: () => void
  onRemoveWaypoint: (index: number) => void
  onSpeedChange: (speed: number) => void
  onWeatherToggle: () => void
}

function formatCoord(point: [number, number] | null): string {
  if (!point) return '--'
  return `${point[1].toFixed(4)}N, ${point[0].toFixed(4)}E`
}

function StepIndicator({ current }: { current: NavStep }) {
  const steps = [
    { n: 1 as NavStep, icon: <MapPin size={14} />, label: 'Start' },
    { n: 2 as NavStep, icon: <Flag size={14} />, label: 'End' },
    { n: 3 as NavStep, icon: <Route size={14} />, label: 'Route' },
    { n: 4 as NavStep, icon: <Save size={14} />, label: 'Save' },
  ]
  return (
    <div className="nav-steps">
      {steps.map((s, i) => (
        <div key={s.n} className={`nav-step ${s.n === current ? 'active' : ''} ${s.n < current ? 'done' : ''}`}>
          <div className="nav-step-circle">{s.n < current ? '\u2713' : s.icon}</div>
          <span>{s.label}</span>
          {i < steps.length - 1 && <div className={`nav-step-line ${s.n < current ? 'filled' : ''}`} />}
        </div>
      ))}
    </div>
  )
}

function WeatherBadge({ score, summary }: { score: number; summary: string }) {
  const color = score > 0.7 ? '#5cf2ed' : score > 0.4 ? '#ffd166' : '#ff756f'
  const label = score > 0.7 ? 'Good' : score > 0.4 ? 'Moderate' : 'Rough'
  return (
    <div className="nav-weather-badge" style={{ borderColor: color }}>
      <span style={{ color }}>{label}</span>
      <small>{summary}</small>
    </div>
  )
}

function TrafficBadge({ level }: { level: 'low' | 'medium' | 'high' }) {
  const config = { low: { color: '#5cf2ed', label: 'Low traffic' }, medium: { color: '#ffd166', label: 'Moderate traffic' }, high: { color: '#ff756f', label: 'Heavy traffic' } }
  const c = config[level]
  return <div className="nav-traffic-badge" style={{ color: c.color }}>{c.label}</div>
}

function RouteCard({ index, route, isSelected, meta, onSelect }: {
  index: number
  route: NavRoute
  isSelected: boolean
  meta?: RouteGroupResponse
  onSelect: () => void
}) {
  const isSafest = index === 0
  const borderColor = isSafest ? '#5cf2ed' : '#ffd166'
  const bgGlow = isSafest ? 'rgba(92,242,237,.08)' : 'rgba(255,209,102,.08)'
  return (
    <button
      type="button"
      className={`nav-route-card ${isSelected ? 'selected' : ''}`}
      style={{ borderColor: isSelected ? borderColor : undefined, background: isSelected ? bgGlow : undefined }}
      onClick={onSelect}
    >
      <div className="nav-route-card-header">
        <div className="nav-route-icon" style={{ background: borderColor }}>
          {isSafest ? <ShipWheel size={16} /> : <Navigation2 size={16} />}
        </div>
        <div>
          <strong>{isSafest ? 'Safest Route' : 'Direct Route'}</strong>
          <small>{isSafest ? 'Best conditions, avoids rough areas' : 'Shortest path, may have rough seas'}</small>
        </div>
      </div>
      <div className="nav-route-card-stats">
        <div><span>Distance</span><b>{route.distance_km.toFixed(0)} km</b></div>
        <div><span>ETA</span><b>{route.eta_hours.toFixed(1)} h</b></div>
        <div><span>Heading</span><b>{route.heading.toFixed(0)}&deg;</b></div>
      </div>
      {meta && (
        <div className="nav-route-card-conditions">
          <WeatherBadge score={meta.weather_score} summary={meta.weather_summary} />
          <TrafficBadge level={meta.traffic_level} />
          {meta.pfz_summary && <div className="nav-pfz-badge">{meta.pfz_summary}</div>}
        </div>
      )}
      {isSelected && <div className="nav-route-selected-indicator" style={{ background: borderColor }}>Selected</div>}
    </button>
  )
}

export default function NavigationPanel({
  origin, destination, originDetails, destinationDetails, route, alternatives, selectedRouteIndex, routeGroupMeta,
  loading, pointLoading, picking, routeMode, waypoints, speed, showWeather, savedRoutes, geocodeResults, geocodeLoading,
  geocodeTarget,
  onUseCurrentLocation, onPickOnMap, onSearchPoint, onUseGeocode, onSetRouteMode,
  onCalculate, onSelectRoute, onSaveRoute, onLoadRoute, onDeleteSavedRoute, onClear, onClose,
  onAddWaypoint, onRemoveWaypoint, onSpeedChange, onWeatherToggle,
}: NavigationPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canPlan = !!origin && !!destination
  const hasRoute = !!route
  const currentStep: NavStep = !origin ? 1 : !destination ? 2 : !hasRoute ? 3 : 4

  const handleExport = useCallback(() => {
    const data = { version: 1, exportedAt: new Date().toISOString(), routes: savedRoutes }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `safelink-routes-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [savedRoutes])

  const handleImport = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        if (data.version === 1 && Array.isArray(data.routes)) {
          const merged = [...data.routes, ...savedRoutes].slice(0, 12)
          localStorage.setItem('safelink.nav.routes', JSON.stringify(merged))
          window.location.reload()
        }
      } catch { /* ignore invalid file */ }
    }
    reader.readAsText(file)
    event.target.value = ''
  }, [savedRoutes])

  return (
    <>
      <section className="nav-planner glass" aria-label="Navigation route planner">
        <div className="nav-planner-header">
          <div>
            <h2><ShipWheel size={18} /> Route Planner</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close navigation"><X size={17} /></button>
        </div>

        <StepIndicator current={currentStep} />

        <div className="nav-planner-scroll">
          {/* Step 1: Set Origin */}
          <section className={`nav-workflow-section ${currentStep === 1 ? 'nav-step-active' : 'nav-step-done'}`}>
            <div className="nav-section-title">
              <MapPin size={15} />
              <span>Step 1: Set Start Point</span>
              {origin && <span className="nav-step-check">{'\u2713'}</span>}
            </div>
            {origin && <div className="nav-point-coord">{formatCoord(origin)}</div>}
            <div className="nav-point-actions">
              <button type="button" className="nav-action-button" onClick={onUseCurrentLocation}>
                <LocateFixed size={15} /> My Location
              </button>
              <button type="button" className={`nav-action-button ${picking === 'origin' ? 'active' : ''}`} onClick={() => onPickOnMap('origin')}>
                <Crosshair size={15} /> {picking === 'origin' ? 'Tap map...' : 'Tap on Map'}
              </button>
            </div>
            <form className="nav-search-row" onSubmit={(event) => {
              event.preventDefault()
              const form = event.currentTarget
              const input = new FormData(form).get('origin-search')
              onSearchPoint('origin', String(input || ''))
            }}>
              <input name="origin-search" placeholder="Port name or coordinates" aria-label="Origin search" />
              <button type="submit" aria-label="Search origin"><Search size={15} /></button>
            </form>
            {geocodeLoading && geocodeTarget === 'origin' && <small className="nav-muted">Searching...</small>}
            {geocodeTarget === 'origin' && geocodeResults.length > 0 && (
              <div className="nav-geocode-results">
                {geocodeResults.slice(0, 3).map((result) => (
                  <button type="button" key={`${result.latitude}-${result.longitude}-${result.name}`} onClick={() => onUseGeocode('origin', result)}>
                    <span>{result.name}</span>
                    <small>{result.latitude.toFixed(4)}, {result.longitude.toFixed(4)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Step 2: Set Destination */}
          <section className={`nav-workflow-section ${currentStep === 2 ? 'nav-step-active' : currentStep > 2 ? 'nav-step-done' : ''}`}>
            <div className="nav-section-title">
              <Flag size={15} />
              <span>Step 2: Set Destination</span>
              {destination && <span className="nav-step-check">{'\u2713'}</span>}
            </div>
            {destination && <div className="nav-point-coord">{formatCoord(destination)}</div>}
            <div className="nav-point-actions">
              <button type="button" className={`nav-action-button ${picking === 'destination' ? 'active' : ''}`} onClick={() => onPickOnMap('destination')}>
                <Crosshair size={15} /> {picking === 'destination' ? 'Tap map...' : 'Tap on Map'}
              </button>
            </div>
            <form className="nav-search-row" onSubmit={(event) => {
              event.preventDefault()
              const form = event.currentTarget
              const input = new FormData(form).get('dest-search')
              onSearchPoint('destination', String(input || ''))
            }}>
              <input name="dest-search" placeholder="Port name or coordinates" aria-label="Destination search" />
              <button type="submit" aria-label="Search destination"><Search size={15} /></button>
            </form>
            {geocodeLoading && geocodeTarget === 'destination' && <small className="nav-muted">Searching...</small>}
            {geocodeTarget === 'destination' && geocodeResults.length > 0 && (
              <div className="nav-geocode-results">
                {geocodeResults.slice(0, 3).map((result) => (
                  <button type="button" key={`${result.latitude}-${result.longitude}-${result.name}`} onClick={() => onUseGeocode('destination', result)}>
                    <span>{result.name}</span>
                    <small>{result.latitude.toFixed(4)}, {result.longitude.toFixed(4)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Step 3: Choose Route */}
          {canPlan && (
            <section className={`nav-workflow-section ${currentStep === 3 ? 'nav-step-active' : currentStep > 3 ? 'nav-step-done' : ''}`}>
              <div className="nav-section-title">
                <Route size={15} />
                <span>Step 3: Choose Route</span>
              </div>

              <div className="nav-speed-row">
                <label htmlFor="nav-speed">Speed</label>
                <input
                  id="nav-speed"
                  type="range"
                  className="nav-speed-slider"
                  value={speed}
                  min={1}
                  max={50}
                  step={1}
                  onChange={(event) => onSpeedChange(Number(event.target.value))}
                />
                <span className="nav-speed-value">{speed} kt</span>
              </div>

              <label className="nav-check-row">
                <input type="checkbox" checked={showWeather} onChange={onWeatherToggle} />
                <span>Show weather along route</span>
              </label>

              {waypoints.length > 0 && (
                <div className="nav-waypoints">
                  {waypoints.map((wp, index) => (
                    <div className="nav-waypoint-item" key={`${wp[0]}-${wp[1]}-${index}`}>
                      <span>Waypoint {index + 1}: {formatCoord(wp)}</span>
                      <button type="button" className="nav-waypoint-remove" onClick={() => onRemoveWaypoint(index)} aria-label={`Remove waypoint ${index + 1}`}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" className={`nav-waypoint-add ${picking === 'waypoint' ? 'active' : ''}`} onClick={onAddWaypoint}>
                <MapPin size={14} /> {picking === 'waypoint' ? 'Tap map to place...' : 'Add waypoint'}
              </button>

              <button type="button" className="nav-primary-button" onClick={onCalculate} disabled={loading}>
                {loading ? 'Calculating...' : hasRoute ? 'Recalculate' : 'Find Best Route'}
              </button>

              {hasRoute && alternatives.length >= 2 && (
                <div className="nav-route-cards">
                  <RouteCard index={0} route={alternatives[0]} isSelected={selectedRouteIndex === 0} meta={routeGroupMeta?.safest} onSelect={() => onSelectRoute(0)} />
                  <RouteCard index={1} route={alternatives[1]} isSelected={selectedRouteIndex === 1} meta={routeGroupMeta?.direct} onSelect={() => onSelectRoute(1)} />
                </div>
              )}
            </section>
          )}

          {/* Step 4: Save / Export */}
          {hasRoute && (
            <section className="nav-workflow-section nav-step-active">
              <div className="nav-section-title">
                <Save size={15} />
                <span>Step 4: Save Route</span>
              </div>

              {route.warnings.length > 0 && (
                <div className="nav-warnings">
                  {route.warnings.map((warning, index) => (
                    <div key={index} className={`nav-warning nav-warning-${warning.severity}`}>
                      <AlertTriangle size={14} /> {warning.message}
                    </div>
                  ))}
                </div>
              )}

              <div className="nav-save-row">
                <button type="button" className="nav-primary-button" onClick={onSaveRoute}><Save size={15} /> Save Route</button>
                <button type="button" className="nav-secondary-button" onClick={onClear}>Clear</button>
              </div>
            </section>
          )}
        </div>
      </section>

      {/* History sidebar */}
      <aside className="nav-history glass" aria-label="Saved route history">
        <div className="nav-history-header">
          <div className="nav-history-title"><History size={15} /> Saved Routes</div>
          <div className="nav-history-actions">
            <button type="button" className="nav-history-btn" onClick={handleExport} aria-label="Export routes" title="Download routes as JSON">
              <Download size={14} />
            </button>
            <button type="button" className="nav-history-btn" onClick={() => fileInputRef.current?.click()} aria-label="Import routes" title="Load routes from JSON">
              <Upload size={14} />
            </button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
          </div>
        </div>
        {savedRoutes.length === 0 && <p>No saved routes yet.</p>}
        {savedRoutes.map((saved) => (
          <article className="nav-history-item" key={saved.id}>
            <button type="button" onClick={() => onLoadRoute(saved)}>
              <strong>{formatCoord(saved.origin)} to {formatCoord(saved.destination)}</strong>
              <span>{saved.distance_km.toFixed(0)} km · {saved.eta_hours.toFixed(1)} h · {saved.speed_knots} kt</span>
              <small>{new Date(saved.savedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
            </button>
            <button type="button" className="nav-history-delete" onClick={() => onDeleteSavedRoute(saved.id)} aria-label={`Delete route`}>
              <Trash2 size={13} />
            </button>
          </article>
        ))}
      </aside>
    </>
  )
}
