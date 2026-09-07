const OPEN_METEO_FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
const WIND_MATCH_MAX_HOURS = 3

interface OpenMeteoMarineHourlyResponse {
  error?: boolean
  reason?: string
  hourly?: {
    time?: string[]
    wind_speed_10m?: (number | null)[]
  }
}

export const hourKey = (time: string): string => time.slice(0, 13)

const timestampMs = (time: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/.exec(time)
  if (match) {
    const [, year, month, day, hour] = match
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour))
  }
  const ms = Date.parse(time)
  return Number.isFinite(ms) ? ms : null
}

export function windForTime(
  windByHour: Map<string, number>,
  time: string,
  maxMatchHours: number = WIND_MATCH_MAX_HOURS,
): number | null {
  const exact = windByHour.get(hourKey(time))
  if (exact !== undefined) return exact
  const target = timestampMs(time)
  if (target === null) return null
  const limit = maxMatchHours * 3_600_000
  let best: { distance: number; value: number } | null = null
  for (const [key, value] of windByHour) {
    const ms = timestampMs(key)
    if (ms === null) continue
    const distance = Math.abs(ms - target)
    if (distance <= limit && (best === null || distance < best.distance)) {
      best = { distance, value }
    }
  }
  return best === null ? null : best.value
}

export async function fetchWindSpeedKnots(
  lng: number,
  lat: number,
  startTime: string,
  endTime: string,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: 'wind_speed_10m',
    wind_speed_unit: 'kn',
    timezone: 'GMT',
    start_date: startTime.slice(0, 10),
    end_date: endTime.slice(0, 10),
  })
  const response = await fetch(`${OPEN_METEO_FORECAST_ENDPOINT}?${params}`, { signal })
  if (!response.ok) throw new Error(`Open-Meteo marine API returned ${response.status}`)
  const payload = (await response.json()) as OpenMeteoMarineHourlyResponse
  if (payload.error) throw new Error(payload.reason ?? 'Open-Meteo marine API returned an error')

  const windByHour = new Map<string, number>()
  const times = payload.hourly?.time ?? []
  const speeds = payload.hourly?.wind_speed_10m ?? []
  times.forEach((time, index) => {
    const speed = speeds[index]
    if (speed !== null && speed !== undefined && Number.isFinite(speed)) {
      windByHour.set(hourKey(time), speed)
    }
  })
  return windByHour
}