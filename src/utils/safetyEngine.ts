export type VesselType = 'small' | 'commercial'

export type SafetyStatus = 'GREEN' | 'YELLOW' | 'RED'

export interface TimelineForecastHour {
  time: string
  waveHeight: number
  windSpeed: number
}

export interface SafetyResult {
  status: SafetyStatus
  reason: string
}

interface ThresholdRule {
  greenUnderWave: number
  greenUnderWind: number
  redOverWave: number
  redOverWind: number
}

const THRESHOLDS: Record<VesselType, ThresholdRule> = {
  small: {
    greenUnderWave: 1.5,
    greenUnderWind: 15,
    redOverWave: 2.5,
    redOverWind: 25,
  },
  commercial: {
    greenUnderWave: 3.0,
    greenUnderWind: 25,
    redOverWave: 4.5,
    redOverWind: 40,
  },
}

const DAY_MS = 86_400_000

const normalizeVesselType = (vesselType: VesselType): VesselType =>
  vesselType === 'commercial' ? 'commercial' : 'small'

const parseHour = (time: string): number | null => {
  const match = /T(\d{2}):/.exec(time)
  if (match) return Number(match[1])
  const ms = Date.parse(time)
  return Number.isFinite(ms) ? new Date(ms).getUTCHours() : null
}

const dayOffsetFrom = (firstTime: string, time: string, fallbackIndex: number): number => {
  const start = Date.parse(firstTime)
  const current = Date.parse(time)
  if (Number.isFinite(start) && Number.isFinite(current)) {
    return Math.max(1, Math.floor((current - start) / DAY_MS) + 1)
  }
  return fallbackIndex + 1
}

const whenLabel = (time: string, firstTime: string, index: number): string => {
  const day = dayOffsetFrom(firstTime, time, index)
  const hour = parseHour(time)
  return hour !== null && hour > 0
    ? `day ${day} at ${String(hour).padStart(2, '0')}:00`
    : `day ${day}`
}

export function calculateSafetyMargin(
  vesselType: VesselType,
  timelineForecast: TimelineForecastHour[],
): SafetyResult {
  const rule = THRESHOLDS[normalizeVesselType(vesselType)]

  if (!Array.isArray(timelineForecast) || timelineForecast.length === 0) {
    return {
      status: 'YELLOW',
      reason: 'No forecast data available for the selected window; unable to determine a Go / No-Go margin.',
    }
  }

  const firstTime = timelineForecast[0].time

  for (let i = 0; i < timelineForecast.length; i++) {
    const hour = timelineForecast[i]
    const waveHeight = Number(hour.waveHeight)
    const windSpeed = Number(hour.windSpeed)
    const label = whenLabel(hour.time, firstTime, i)

    if (Number.isFinite(waveHeight) && waveHeight > rule.redOverWave) {
      return {
        status: 'RED',
        reason: `High waves of ${waveHeight.toFixed(1)}m expected on ${label}.`,
      }
    }

    if (Number.isFinite(windSpeed) && windSpeed > rule.redOverWind) {
      return {
        status: 'RED',
        reason: `Wind speeds of ${Math.round(windSpeed)} knots expected on ${label}.`,
      }
    }
  }

  let allGreen = true
  const cautionPeriods: string[] = []

  for (let i = 0; i < timelineForecast.length; i++) {
    const hour = timelineForecast[i]
    const waveHeight = Number(hour.waveHeight)
    const windSpeed = Number(hour.windSpeed)

    if (!Number.isFinite(waveHeight) || !Number.isFinite(windSpeed)) continue

    const green = waveHeight < rule.greenUnderWave && windSpeed < rule.greenUnderWind
    if (!green) allGreen = false

    if (!green) {
      const issues: string[] = []
      if (waveHeight >= rule.greenUnderWave) issues.push(`waves ${waveHeight.toFixed(1)}m`)
      if (windSpeed >= rule.greenUnderWind) issues.push(`wind ${Math.round(windSpeed)} kt`)
      cautionPeriods.push(`${whenLabel(hour.time, firstTime, i)} (${issues.join(', ')})`)
    }
  }

  if (allGreen) {
    return {
      status: 'GREEN',
      reason: `All ${timelineForecast.length} hours in the selected window are within safe limits (waves < ${rule.greenUnderWave}m, wind < ${rule.greenUnderWind} kt) for ${normalizeVesselType(vesselType)} vessels.`,
    }
  }

  return {
    status: 'YELLOW',
    reason: `Caution advised ${cautionPeriods.join('; ')}. No RED thresholds were reached.`,
  }
}