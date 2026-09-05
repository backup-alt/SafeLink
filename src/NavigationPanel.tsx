import { AlertTriangle, Compass, Crosshair, History, LocateFixed, MapPin, Navigation2, Plus, Route, Save, Search, ShipWheel, Trash2, X } from 'lucide-react'
import type { GeocodeResult, NauticalPointDetails, NavRoute, SavedNavRoute } from './types'

type NavPickTarget = 'origin' | 'destination' | 'waypoint' | null
type RouteMode = 'auto' | 'manual' | null

interface NavigationPanelProps {
  origin: [number, number] | null
  destination: [number, number] | null
  originDetails: NauticalPointDetails | null
  destinationDetails: NauticalPointDetails | null
  route: NavRoute | null
  alternatives: NavRoute[]
  selectedRouteIndex: number
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
  if (!point) return 'Not set'
  return `${point[1].toFixed(5)}°, ${point[0].toFixed(5)}°`
}

function formatMeasure(item: NauticalPointDetails | null, key: keyof NauticalPointDetails): string {
  const value = item?.[key] as { value: number | null; unit: string } | null | undefined
  if (!value || value.value === null || value.value === undefined) return 'Unavailable'
  return `${Number(value.value).toFixed(key === 'depth' ? 0 : 1)} ${value.unit}`
}

function PointSummary({ title, point, details, loading }: {
  title: string
  point: [number, number] | null
  details: NauticalPointDetails | null
  loading: boolean
}) {
  return (
    <div className="nav-point-summary">
      <div className="nav-point-summary-head">
        <span>{title}</span>
        <b>{loading ? 'Loading' : point ? 'Ready' : 'Unset'}</b>
      </div>
      <div className="nav-point-coord">{formatCoord(point)}</div>
      {point && (
        <div className="nav-metrics-grid">
          <div><span>Depth</span><b>{formatMeasure(details, 'depth')}</b></div>
          <div><span>Temp</span><b>{formatMeasure(details, 'temperature')}</b></div>
          <div><span>Waves</span><b>{formatMeasure(details, 'wave_height')}</b></div>
        </div>
      )}
    </div>
  )
}

function PointSetter({ type, point, details, loading, picking, allowCurrentLocation, geocodeResults, geocodeLoading, onUseCurrentLocation, onPickOnMap, onSearchPoint, onUseGeocode }: {
  type: 'origin' | 'destination'
  point: [number, number] | null
  details: NauticalPointDetails | null
  loading: boolean
  picking: NavPickTarget
  allowCurrentLocation: boolean
  geocodeResults: GeocodeResult[]
  geocodeLoading: boolean
  onUseCurrentLocation: () => void
  onPickOnMap: (type: 'origin' | 'destination') => void
  onSearchPoint: (type: 'origin' | 'destination', query: string) => void
  onUseGeocode: (type: 'origin' | 'destination', result: GeocodeResult) => void
}) {
  const label = type === 'origin' ? 'Origin' : 'Destination'
  return (
    <section className="nav-workflow-section">
      <div className="nav-section-title">
        <MapPin size={15} />
        <span>{label}</span>
      </div>
      <PointSummary title={label} point={point} details={details} loading={loading} />
      <div className="nav-point-actions">
        {allowCurrentLocation && (
          <button type="button" className="nav-action-button" onClick={onUseCurrentLocation}>
            <LocateFixed size={15} /> Auto locate
          </button>
        )}
        <button type="button" className={`nav-action-button ${picking === type ? 'active' : ''}`} onClick={() => onPickOnMap(type)}>
          <Crosshair size={15} /> {picking === type ? 'Click map' : 'Select on map'}
        </button>
      </div>
      <form className="nav-search-row" onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const input = new FormData(form).get(`${type}-search`)
        onSearchPoint(type, String(input || ''))
      }}>
        <input name={`${type}-search`} placeholder="Coordinates or place name" aria-label={`${label} search`} />
        <button type="submit" aria-label={`Search ${label}`}><Search size={15} /></button>
      </form>
      {geocodeLoading && <small className="nav-muted">Searching places...</small>}
      {geocodeResults.length > 0 && (
        <div className="nav-geocode-results">
          {geocodeResults.slice(0, 3).map((result) => (
            <button type="button" key={`${result.latitude}-${result.longitude}-${result.name}`} onClick={() => onUseGeocode(type, result)}>
              <span>{result.name}</span>
              <small>{result.latitude.toFixed(4)}°, {result.longitude.toFixed(4)}°</small>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export default function NavigationPanel({
  origin, destination, originDetails, destinationDetails, route, alternatives, selectedRouteIndex, loading, pointLoading,
  picking, routeMode, waypoints, speed, showWeather, savedRoutes, geocodeResults, geocodeLoading,
  geocodeTarget,
  onUseCurrentLocation, onPickOnMap, onSearchPoint, onUseGeocode, onSetRouteMode,
  onCalculate, onSelectRoute, onSaveRoute, onLoadRoute, onDeleteSavedRoute, onClear, onClose,
  onAddWaypoint, onRemoveWaypoint, onSpeedChange, onWeatherToggle,
}: NavigationPanelProps) {
  const canPlan = !!origin && !!destination
  return (
    <>
      <section className="nav-planner glass" aria-label="Navigation route planner">
        <div className="nav-planner-header">
          <div>
            <h2><ShipWheel size={18} /> Nautical Route Planner</h2>
            <p>Advisory planning workspace</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close navigation"><X size={17} /></button>
        </div>

        <div className="nav-planner-scroll">
          <PointSetter
            type="origin"
            point={origin}
            details={originDetails}
            loading={pointLoading === 'origin'}
            picking={picking}
            allowCurrentLocation
            geocodeResults={geocodeTarget === 'origin' ? geocodeResults : []}
            geocodeLoading={geocodeLoading && geocodeTarget === 'origin'}
            onUseCurrentLocation={onUseCurrentLocation}
            onPickOnMap={onPickOnMap}
            onSearchPoint={onSearchPoint}
            onUseGeocode={onUseGeocode}
          />

          <PointSetter
            type="destination"
            point={destination}
            details={destinationDetails}
            loading={pointLoading === 'destination'}
            picking={picking}
            allowCurrentLocation={false}
            geocodeResults={geocodeTarget === 'destination' ? geocodeResults : []}
            geocodeLoading={geocodeLoading && geocodeTarget === 'destination'}
            onUseCurrentLocation={onUseCurrentLocation}
            onPickOnMap={onPickOnMap}
            onSearchPoint={onSearchPoint}
            onUseGeocode={onUseGeocode}
          />

          {canPlan && (
            <section className="nav-workflow-section">
              <div className="nav-section-title">
                <Route size={15} />
                <span>Route setup</span>
              </div>
              <div className="nav-mode-grid">
                <button type="button" className={routeMode === 'auto' ? 'active' : ''} onClick={() => onSetRouteMode('auto')}>
                  <Compass size={16} />
                  <span>Automatic</span>
                  <small>Generate route, distance, headings, ETA and condition markers.</small>
                </button>
                <button type="button" className={routeMode === 'manual' ? 'active' : ''} onClick={() => onSetRouteMode('manual')}>
                  <MapPin size={16} />
                  <span>Manual</span>
                  <small>Add route points yourself, then calculate the plan.</small>
                </button>
              </div>

              <div className="nav-speed-row">
                <label htmlFor="nav-speed">Speed</label>
                <input
                  id="nav-speed"
                  type="number"
                  className="nav-speed-input"
                  value={speed}
                  min={1}
                  max={50}
                  step={0.5}
                  onChange={(event) => onSpeedChange(Math.max(1, Math.min(50, parseFloat(event.target.value) || 10)))}
                />
                <span className="nav-speed-unit">knots</span>
              </div>

              <label className="nav-check-row">
                <input type="checkbox" checked={showWeather} onChange={onWeatherToggle} />
                <span>Show weather markers along route</span>
              </label>

              <div className="nav-waypoints">
                <div className="nav-waypoint-head">
                  <span>Waypoints between origin and destination</span>
                </div>
                <button type="button" className={`nav-waypoint-add ${picking === 'waypoint' ? 'active' : ''}`} onClick={onAddWaypoint}>
                  <Plus size={14} /> {picking === 'waypoint' ? 'Click the map to place waypoint' : 'Add waypoint between'}
                </button>
                {waypoints.length === 0 && <small className="nav-muted">No extra waypoints yet.</small>}
                {waypoints.map((waypoint, index) => (
                  <div className="nav-waypoint-item" key={`${waypoint[0]}-${waypoint[1]}-${index}`}>
                    <span>Turn {index + 1}: {formatCoord(waypoint)}</span>
                    <button type="button" className="nav-waypoint-remove" onClick={() => onRemoveWaypoint(index)} aria-label={`Remove waypoint ${index + 1}`}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              <button type="button" className="nav-primary-button" onClick={onCalculate} disabled={loading || !routeMode}>
                {loading ? 'Calculating...' : route ? 'Recalculate Route' : routeMode === 'manual' ? 'Calculate Manual Route' : 'Generate Route'}
              </button>
            </section>
          )}

          {route && (
            <section className="nav-workflow-section nav-alternatives">
              <div className="nav-section-title">
                <Route size={15} />
                <span>Route alternatives</span>
              </div>
              <div className="nav-alternative-list">
                {alternatives.map((alt, index) => (
                  <button
                    type="button"
                    key={alt.label}
                    className={`nav-alternative-card ${index === selectedRouteIndex ? 'selected' : ''}`}
                    onClick={() => onSelectRoute(index)}
                  >
                    <div className="nav-alt-header">
                      <span className={`nav-alt-dot nav-alt-dot-${index}`} />
                      <strong>{alt.label}</strong>
                    </div>
                    <div className="nav-alt-metrics">
                      <div><span>Distance</span><b>{alt.distance_km.toFixed(1)} km</b></div>
                      <div><span>ETA</span><b>{alt.eta_hours.toFixed(1)} h</b></div>
                      <div><span>Heading</span><b>{alt.heading.toFixed(0)}&deg;</b></div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {route && (
            <section className="nav-workflow-section nav-brief">
              <div className="nav-section-title">
                <Navigation2 size={15} />
                <span>Route brief</span>
              </div>
              <div className="nav-route-metrics">
                <div><span>Distance</span><b>{route.distance_km.toFixed(1)} km</b></div>
                <div><span>ETA</span><b>{route.eta_hours.toFixed(1)} h</b></div>
                <div><span>Initial heading</span><b>{route.heading.toFixed(0)}°</b></div>
              </div>
              <div className="nav-leg-list">
                {route.legs.map((leg, index) => (
                  <div key={index}>
                    <span>Leg {index + 1}</span>
                    <b>{leg.distance_km.toFixed(0)} km - {leg.heading.toFixed(0)}°</b>
                  </div>
                ))}
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
                <button type="button" className="nav-primary-button" onClick={onSaveRoute}><Save size={15} /> Save</button>
                <button type="button" className="nav-secondary-button" onClick={onClear}>Clear</button>
              </div>
            </section>
          )}
        </div>
      </section>

      <aside className="nav-history glass" aria-label="Saved route history">
        <div className="nav-history-title"><History size={15} /> Route history</div>
        {savedRoutes.length === 0 && <p>No saved route plans yet.</p>}
        {savedRoutes.map((saved) => (
          <article className="nav-history-item" key={saved.id}>
            <button type="button" onClick={() => onLoadRoute(saved)}>
              <strong>{saved.name}</strong>
              <span>{saved.distance_km.toFixed(1)} km - {saved.eta_hours.toFixed(1)} h</span>
              <small>{new Date(saved.savedAt).toLocaleString('en-IN')}</small>
            </button>
            <button type="button" className="nav-history-delete" onClick={() => onDeleteSavedRoute(saved.id)} aria-label={`Delete ${saved.name}`}>
              <Trash2 size={13} />
            </button>
          </article>
        ))}
      </aside>
    </>
  )
}
