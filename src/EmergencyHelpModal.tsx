import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, MapPin, Radio, Ship, X } from 'lucide-react'
import type { EmergencyType, Vessel } from './types'
import { EMERGENCY_TYPES } from './types'
import { sendEmergencyHelp } from './api'

type Stage = 'form' | 'submitting' | 'success' | 'error'

interface Props {
  vessel: Vessel
  onClose: () => void
}

export default function EmergencyHelpModal({ vessel, onClose }: Props) {
  const [stage, setStage] = useState<Stage>('form')
  const [emergencyType, setEmergencyType] = useState<EmergencyType>('fire')
  const [message, setMessage] = useState('')
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null)
  const [locationError, setLocationError] = useState('')
  const [result, setResult] = useState<{ request_id: string; status: string; message: string } | null>(null)
  const [submitError, setSubmitError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not available')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => setLocationError('Unable to get your location'),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const handleSubmit = useCallback(async () => {
    if (!userLocation) return
    setStage('submitting')
    setSubmitError('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await sendEmergencyHelp({
        emergency_type: emergencyType,
        vessel_name: vessel.name || 'Unknown',
        vessel_mmsi: vessel.mmsi,
        vessel_lat: vessel.latitude,
        vessel_lon: vessel.longitude,
        user_lat: userLocation.lat,
        user_lon: userLocation.lon,
        message: message.trim() || undefined,
      }, controller.signal)
      setResult(res)
      setStage('success')
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setSubmitError(err instanceof Error ? err.message : 'Request failed')
      setStage('error')
    }
  }, [emergencyType, message, userLocation, vessel])

  const canSubmit = userLocation && stage !== 'submitting' && stage !== 'success'

  return (
    <div className="emergency-overlay" role="dialog" aria-modal="true" aria-label="Emergency assistance">
      <div className="emergency-modal glass">
        <button type="button" className="emergency-close" onClick={onClose} aria-label="Close"><X size={16} /></button>

        {stage === 'form' && (
          <>
            <div className="emergency-header">
              <AlertTriangle size={20} className="emergency-icon" />
              <div>
                <div className="emergency-title">Request Emergency Assistance</div>
                <div className="emergency-subtitle">This will log an emergency request in SafeLink backend</div>
              </div>
            </div>

            <div className="emergency-target glass">
              <div className="emergency-target-row"><Ship size={14} /><span>{vessel.name || 'Unknown Vessel'}</span></div>
              <div className="emergency-target-detail">MMSI: {vessel.mmsi}</div>
              <div className="emergency-target-detail">Position: {vessel.latitude.toFixed(4)}°, {vessel.longitude.toFixed(4)}°</div>
            </div>

            <label className="emergency-label">Emergency Type</label>
            <div className="emergency-type-grid">
              {(Object.entries(EMERGENCY_TYPES) as [EmergencyType, string][]).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`emergency-type-btn${emergencyType === key ? ' active' : ''}`}
                  onClick={() => setEmergencyType(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="emergency-label">Additional Details (optional)</label>
            <textarea
              className="emergency-textarea"
              rows={3}
              maxLength={500}
              placeholder="Describe the situation..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />

            <div className="emergency-location">
              <MapPin size={14} />
              {userLocation
                ? <span>Your location: {userLocation.lat.toFixed(4)}°, {userLocation.lon.toFixed(4)}°</span>
                : locationError
                  ? <span className="emergency-location-error">{locationError}</span>
                  : <span>Getting your location...</span>
              }
            </div>

            <div className="emergency-notice">
              <Radio size={13} />
              <span>This request will be logged in SafeLink. It is <strong>not</strong> transmitted to the vessel via maritime radio.</span>
            </div>

            <div className="emergency-actions">
              <button type="button" className="emergency-cancel-btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="emergency-submit-btn"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                Send Emergency Request
              </button>
            </div>
          </>
        )}

        {stage === 'submitting' && (
          <div className="emergency-status">
            <div className="emergency-spinner" />
            <div>Sending emergency request...</div>
          </div>
        )}

        {stage === 'success' && result && (
          <>
            <div className="emergency-header success">
              <div className="emergency-success-icon">✓</div>
              <div>
                <div className="emergency-title">Emergency Request Sent</div>
                <div className="emergency-subtitle">{result.message}</div>
              </div>
            </div>

            <div className="emergency-result-grid">
              <div className="emergency-result-row"><span>Vessel</span><b>{vessel.name || 'Unknown'}</b></div>
              <div className="emergency-result-row"><span>Emergency</span><b>{EMERGENCY_TYPES[emergencyType]}</b></div>
              <div className="emergency-result-row"><span>Your Location</span><b>{userLocation ? `${userLocation.lat.toFixed(4)}°, ${userLocation.lon.toFixed(4)}°` : 'N/A'}</b></div>
              <div className="emergency-result-row"><span>Request ID</span><b className="emergency-request-id">{result.request_id}</b></div>
              <div className="emergency-result-row"><span>Status</span><b className="emergency-status-badge">{result.status.toUpperCase()}</b></div>
            </div>

            <button type="button" className="emergency-close-btn" onClick={onClose}>Close</button>
          </>
        )}

        {stage === 'error' && (
          <>
            <div className="emergency-header error">
              <AlertTriangle size={20} className="emergency-icon-error" />
              <div>
                <div className="emergency-title">Request Failed</div>
                <div className="emergency-subtitle">{submitError}</div>
              </div>
            </div>
            <div className="emergency-actions">
              <button type="button" className="emergency-cancel-btn" onClick={onClose}>Close</button>
              <button type="button" className="emergency-submit-btn" onClick={() => setStage('form')}>Try Again</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
