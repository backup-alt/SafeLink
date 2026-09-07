import { useEffect, useRef, useState } from 'react'
import { fetchCondition } from '../api'
import { fetchWindSpeedKnots, windForTime } from '../utils/marineWeather'
import {
  calculateSafetyMargin,
  type SafetyStatus,
  type TimelineForecastHour,
  type VesselType,
} from '../utils/safetyEngine'

export interface MapInspectionSafetyState {
  status: SafetyStatus | null
  reason: string
  error: string | null
  isLoading: boolean
  forecast: TimelineForecastHour[]
}

export interface UseMapInspectionSafetyOptions {
  point: [number, number] | null
  times: string[]
  vesselType?: VesselType
  enabled?: boolean
  runId?: number
  debounceMs?: number
}

export function useMapInspectionSafety({
  point,
  times,
  vesselType = 'small',
  enabled = false,
  runId = 0,
  debounceMs = 200,
}: UseMapInspectionSafetyOptions): MapInspectionSafetyState {
  const [state, setState] = useState<MapInspectionSafetyState>({
    status: null,
    reason: '',
    error: null,
    isLoading: false,
    forecast: [],
  })
  const requestRef = useRef(0)
  const pointRef = useRef(point)
  pointRef.current = point
  const pointKey = point ? `${point[0].toFixed(6)},${point[1].toFixed(6)}` : null

  useEffect(() => {
    const currentPoint = pointRef.current
    if (!enabled || !currentPoint || times.length === 0) {
      setState({ status: null, reason: '', error: null, isLoading: false, forecast: [] })
      return undefined
    }

    const request = ++requestRef.current
    const controller = new AbortController()
    setState({ status: null, reason: '', error: null, isLoading: true, forecast: [] })
    const [lng, lat] = currentPoint
    const startTime = times[0]
    const endTime = times[times.length - 1]

    const timer = window.setTimeout(async () => {
      try {
        const waveSamples = await Promise.all(times.map(async (time) => {
          try {
            const sample = await fetchCondition('waves', { lng, lat }, time, controller.signal)
            return sample.value
          } catch (error) {
            if (controller.signal.aborted) throw error
            return null
          }
        }))

        const windByHour = await fetchWindSpeedKnots(lng, lat, startTime, endTime, controller.signal)

        if (request !== requestRef.current || controller.signal.aborted) return

        const forecast: TimelineForecastHour[] = []
        times.forEach((time, i) => {
          const waveHeight = waveSamples[i]
          const windSpeed = windForTime(windByHour, time)
          if (waveHeight !== null && windSpeed !== null) forecast.push({ time, waveHeight, windSpeed })
        })

        if (forecast.length === 0) {
          setState({
            status: null,
            reason: '',
            error: 'No complete wave + wind samples available for this point across the selected timeline.',
            isLoading: false,
            forecast,
          })
          return
        }

        const result = calculateSafetyMargin(vesselType, forecast)
        setState({ status: result.status, reason: result.reason, error: null, isLoading: false, forecast })
      } catch (error) {
        if (request !== requestRef.current || controller.signal.aborted) return
        setState({
          status: null,
          reason: '',
          error: error instanceof Error ? error.message : 'Unknown marine data error',
          isLoading: false,
          forecast: [],
        })
      }
    }, debounceMs)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, pointKey, runId, times, vesselType, debounceMs])

  return state
}