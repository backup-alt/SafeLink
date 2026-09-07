import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { LoaderCircle, ShieldCheck, X } from 'lucide-react'
import { useMapInspectionSafety } from './hooks/useMapInspectionSafety'
import type { SafetyStatus, TimelineForecastHour, VesselType } from './utils/safetyEngine'

export interface SafetyIndicatorProps {
  point: [number, number] | null
  times: string[]
}

const VESSEL_MODES: { value: VesselType; label: string }[] = [
  { value: 'small', label: 'Small Vessel' },
  { value: 'commercial', label: 'Commercial' },
]

interface StatusMeta {
  label: string
  dot: string
  badge: CSSProperties
}

const STATUS_META: Record<SafetyStatus, StatusMeta> = {
  GREEN: {
    label: 'GO — SAFE',
    dot: '#6df7c2',
    badge: {
      background: 'linear-gradient(135deg, #10936b, #0fae7e)',
      boxShadow: '0 0 26px rgba(24, 220, 150, .45), 0 10px 26px rgba(0, 0, 0, .35)',
      color: '#ffffff',
    },
  },
  YELLOW: {
    label: 'CAUTION',
    dot: '#ffd166',
    badge: {
      background: 'linear-gradient(135deg, #e8a020, #f7b733)',
      boxShadow: '0 0 24px rgba(247, 183, 51, .45), 0 10px 26px rgba(0, 0, 0, .35)',
      color: '#211a07',
    },
  },
  RED: {
    label: 'NO-GO',
    dot: '#ff7a84',
    badge: {
      background: 'linear-gradient(135deg, #b0141f, #e11d48)',
      boxShadow: '0 0 26px rgba(225, 29, 72, .55), 0 10px 26px rgba(0, 0, 0, .4)',
      color: '#ffffff',
    },
  },
}

const NEUTRAL_BADGE: CSSProperties = {
  background: 'linear-gradient(135deg, #12293a, #0d1b2a)',
  boxShadow: '0 10px 26px rgba(0, 0, 0, .35)',
  color: '#9ab6c2',
}

const CONTAINER: CSSProperties = {
  position: 'absolute',
  right: 20,
  bottom: 180,
  top: 'auto',
  left: 'auto',
  transform: 'none',
  zIndex: 9,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
  pointerEvents: 'none',
  fontFamily: 'Manrope, Inter, system-ui, sans-serif',
}

const VESSEL_THRESHOLDS: Record<VesselType, { greenWave: number; greenWind: number }> = {
  small: { greenWave: 1.5, greenWind: 15 },
  commercial: { greenWave: 3, greenWind: 25 },
}

function formatReportTime(time: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(new Date(time))
}

function reportFor(status: SafetyStatus, forecast: TimelineForecastHour[], vesselType: VesselType): string {
  if (status === 'GREEN') return 'All parameters within safe operating thresholds for the selected vessel.'

  const thresholds = VESSEL_THRESHOLDS[vesselType]
  const waveHazards = forecast.filter((hour) => hour.waveHeight >= thresholds.greenWave)
  const windHazards = forecast.filter((hour) => hour.windSpeed >= thresholds.greenWind)
  const maxWave = waveHazards.reduce<TimelineForecastHour | null>(
    (maximum, hour) => !maximum || hour.waveHeight > maximum.waveHeight ? hour : maximum,
    null,
  )
  const maxWind = windHazards.reduce<TimelineForecastHour | null>(
    (maximum, hour) => !maximum || hour.windSpeed > maximum.windSpeed ? hour : maximum,
    null,
  )

  if (maxWave && (!maxWind || maxWave.waveHeight / thresholds.greenWave >= maxWind.windSpeed / thresholds.greenWind)) {
    return `Hazard Alert: Max wave height of ${maxWave.waveHeight.toFixed(1)}m detected at ${formatReportTime(maxWave.time)} exceeding safe limits.`
  }
  if (maxWind) {
    return `Hazard Alert: Max wind speed of ${Math.round(maxWind.windSpeed)} knots detected at ${formatReportTime(maxWind.time)} exceeding safe limits.`
  }
  return 'Hazard Alert: Forecast conditions exceed safe operating limits for the selected vessel.'
}

const MODE_WRAPPER: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: 8,
  borderRadius: 12,
  background: 'rgba(5, 14, 22, .78)',
  border: '1px solid rgba(126, 166, 182, .28)',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 6px 20px rgba(0, 0, 0, .35)',
}

const MODE_TAB_BASE: CSSProperties = {
  fontFamily: 'inherit',
  border: 0,
  cursor: 'pointer',
  width: 186,
  padding: '9px 12px',
  borderRadius: 7,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.04em',
  transition: 'background .15s, color .15s, box-shadow .15s',
}

const MODE_TAB_ACTIVE: CSSProperties = {
  ...MODE_TAB_BASE,
  background: 'linear-gradient(135deg, #0d6b74, #0a4d5c)',
  color: '#d9fffe',
  boxShadow: 'inset 0 0 0 1px rgba(94, 233, 230, .45)',
}

const MODE_TAB_IDLE: CSSProperties = {
  ...MODE_TAB_BASE,
  background: 'transparent',
  color: '#8fa9b4',
}

const BADGE_BASE: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 16px',
  borderRadius: 9,
  letterSpacing: '.18em',
  textTransform: 'uppercase',
  fontWeight: 800,
  fontSize: 12,
}

const CAPTION: CSSProperties = {
  pointerEvents: 'none',
  color: '#718d97',
  fontSize: 9,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
}

const DISCLAIMER: CSSProperties = {
  pointerEvents: 'none',
  color: '#5f7883',
  fontSize: 9,
  letterSpacing: '.05em',
}

const CLOSE_BUTTON: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 24,
  height: 24,
  padding: 0,
  border: '1px solid rgba(126, 166, 182, .4)',
  borderRadius: '50%',
  background: '#12293a',
  color: '#b8d2d9',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 16,
  lineHeight: 1,
  boxShadow: '0 4px 14px rgba(0, 0, 0, .4)',
}

const FAB: CSSProperties = {
  pointerEvents: 'auto',
  minWidth: 132,
  height: 52,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '0 16px',
  border: '1px solid rgba(94, 233, 230, .55)',
  borderRadius: '50%',
  background: 'linear-gradient(135deg, #123b49, #0b202d)',
  color: '#78f0e9',
  cursor: 'pointer',
  boxShadow: '0 0 0 4px rgba(54, 220, 215, .08), 0 12px 30px rgba(0, 0, 0, .45)',
  transition: 'transform .18s, box-shadow .18s, background .18s',
}

const PANEL: CSSProperties = {
  position: 'relative',
  pointerEvents: 'auto',
  minWidth: 226,
  padding: '12px 10px 10px',
  borderRadius: 12,
  background: 'linear-gradient(135deg, rgba(22, 40, 48, .98), rgba(9, 22, 30, .97))',
  border: '1px solid rgba(125, 205, 209, .3)',
  boxShadow: '0 18px 42px rgba(0, 0, 0, .5)',
  backdropFilter: 'blur(16px)',
}

const PANEL_TITLE: CSSProperties = {
  margin: '0 34px 9px 3px',
  color: '#c9f7f5',
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
}

export function SafetyIndicator({ point, times }: SafetyIndicatorProps) {
  const [hasStartedCheck, setHasStartedCheck] = useState(false)
  const [selectedVessel, setSelectedVessel] = useState<VesselType | null>(null)
  const [mapPointSelected, setMapPointSelected] = useState(false)
  const [analysisRun, setAnalysisRun] = useState(0)
  const [analysisTarget, setAnalysisTarget] = useState<string | null>(null)
  const pointKey = point ? `${point[0].toFixed(6)},${point[1].toFixed(6)}` : null
  const [awaitingPointKey, setAwaitingPointKey] = useState<string | null>(pointKey)
  const lastTriggeredSelection = useRef<string | null>(null)
  const { status, error, isLoading, forecast } = useMapInspectionSafety({
    point,
    times,
    vesselType: selectedVessel ?? 'small',
    enabled: hasStartedCheck && selectedVessel !== null && mapPointSelected && analysisRun > 0 && analysisTarget === pointKey,
    runId: analysisRun,
    debounceMs: 0,
  })

  const resetSafetyCheck = () => {
    setHasStartedCheck(false)
    setSelectedVessel(null)
    setMapPointSelected(false)
    setAnalysisRun(0)
    setAnalysisTarget(null)
    setAwaitingPointKey(pointKey)
    lastTriggeredSelection.current = null
  }

  useEffect(() => {
    const selectionKey = pointKey && selectedVessel ? `${pointKey}:${selectedVessel}` : null
    if (!hasStartedCheck || !selectedVessel || !pointKey || !selectionKey) {
      setMapPointSelected(false)
      setAnalysisRun(0)
      setAnalysisTarget(null)
      return
    }

    if (pointKey === awaitingPointKey) {
      setMapPointSelected(false)
      return
    }

    setMapPointSelected(true)
    if (lastTriggeredSelection.current === selectionKey) return

    lastTriggeredSelection.current = selectionKey
    setAnalysisTarget(pointKey)
    setAnalysisRun((current) => current + 1)
  }, [awaitingPointKey, hasStartedCheck, pointKey, selectedVessel])

  const visibleStatus = hasStartedCheck ? status : null
  const visibleError = hasStartedCheck ? error : null
  const visibleLoading = hasStartedCheck ? isLoading : false
  const meta = visibleStatus ? STATUS_META[visibleStatus] : null
  const badgeStyle = meta ? meta.badge : NEUTRAL_BADGE
  const badgeLabel = meta
    ? meta.label
    : visibleError
      ? 'Error'
      : visibleLoading
        ? 'Analyzing…'
        : !hasStartedCheck
          ? 'Ready to evaluate trip safety.'
          : selectedVessel === null
            ? 'Select a vessel type to continue.'
            : !mapPointSelected
              ? 'Select a point on the map to analyze.'
              : 'Location Selected. Ready to Analyze.'

  const report = visibleStatus && selectedVessel ? reportFor(visibleStatus, forecast, selectedVessel) : null
  const showClose = hasStartedCheck || Boolean(visibleStatus || visibleError || visibleLoading)

  return (
    <div role="status" aria-live="polite" style={CONTAINER}>
      {!hasStartedCheck && (
        <button type="button" aria-label="Run safety check" title="Run safety check" onClick={() => setHasStartedCheck(true)} style={FAB}>
          <ShieldCheck size={23} />
          <span>Run Safety</span>
        </button>
      )}

      {hasStartedCheck && !isLoading && !visibleStatus && (
        <div style={PANEL}>
          <button type="button" aria-label="Cancel safety check" title="Cancel" onClick={resetSafetyCheck} style={CLOSE_BUTTON}>
            <X size={15} />
          </button>
          <p style={PANEL_TITLE}>Select vessel</p>
          <div role="tablist" aria-label="Vessel safety mode" style={MODE_WRAPPER}>
            {VESSEL_MODES.map((mode) => {
              const active = selectedVessel === mode.value
              return (
                <button
                  key={mode.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setSelectedVessel(mode.value)
                    setMapPointSelected(false)
                    setAwaitingPointKey(pointKey)
                    setAnalysisRun(0)
                    setAnalysisTarget(null)
                  }}
                  style={{ ...MODE_TAB_BASE, ...(active ? MODE_TAB_ACTIVE : MODE_TAB_IDLE) }}
                >
                  {mode.label}
                </button>
              )
            })}
          </div>
          <div style={{ ...CAPTION, marginTop: 9, textAlign: 'left' }}>
            {selectedVessel ? 'Select a point on the map to analyze.' : 'Choose a vessel to begin.'}
          </div>
        </div>
      )}

      {isLoading && (
        <div style={{ ...PANEL, minWidth: 226, paddingRight: 38 }}>
          <button type="button" aria-label="Cancel safety check" title="Cancel" onClick={resetSafetyCheck} style={CLOSE_BUTTON}>
            <X size={15} />
          </button>
          <div style={{ ...BADGE_BASE, ...NEUTRAL_BADGE, padding: '8px 4px', boxShadow: 'none' }}>
            <LoaderCircle className="spin" size={17} />
            ANALYZING...
          </div>
        </div>
      )}

      {visibleStatus && !isLoading && (
        <div style={{ ...PANEL, minWidth: 250 }}>
          <button type="button" aria-label="Close safety result" title="Close" onClick={resetSafetyCheck} style={CLOSE_BUTTON}>
            <X size={15} />
          </button>
          <div style={{ ...BADGE_BASE, ...badgeStyle }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: meta?.dot, boxShadow: `0 0 12px ${meta?.dot}` }} />
            {badgeLabel}
          </div>
        </div>
      )}

      {visibleError && !visibleStatus && (
        <div style={{ pointerEvents: 'auto', color: '#ff9d97', fontSize: 11, maxWidth: 420, textAlign: 'center' }}>
          {visibleError}
        </div>
      )}

      {report && <div style={{ ...PANEL, maxWidth: 300, padding: '10px 14px', textAlign: 'left' }}>
        <strong style={{ display: 'block', marginBottom: 3, color: '#9fb6bf', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }}>
          Analyzing Report
        </strong>
        <span style={{ color: '#dcebec', fontSize: 11, lineHeight: 1.5 }}>{report}</span>
      </div>}
      {showClose && <div style={DISCLAIMER}>Visualization only. Not certified navigational guidance.</div>}
    </div>
  )
}

export default SafetyIndicator