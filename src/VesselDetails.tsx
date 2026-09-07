import { Ship, X } from 'lucide-react'
import type { Vessel } from './types'

const VESSEL_TYPE_MAP: Record<string, string> = {
  '30': 'HSC', '40': 'HSC',
  '50': 'SAR/Pilot/Supply', '60': 'Passenger',
  '70': 'Cargo', '80': 'Tanker',
  '90': 'Other',
}

function vesselTypeLabel(type: string): string {
  if (!type) return 'Unknown'
  return VESSEL_TYPE_MAP[type] || `Type ${type}`
}

function navStatusLabel(status: string): string {
  const statuses: Record<string, string> = {
    '0': 'Under way using engine',
    '1': 'At anchor',
    '2': 'Not under command',
    '3': 'Restricted manoeuvrability',
    '4': 'Constrained by draught',
    '5': 'Moored',
    '6': 'Aground',
    '7': 'Engaged in fishing',
    '8': 'Under way sailing',
  }
  return statuses[status] || status || 'Unknown'
}

export default function VesselDetails({ vessel, onClose }: { vessel: Vessel; onClose: () => void }) {
  return (
    <section className="inspection-card glass vessel-details" aria-label="Vessel details">
      <button type="button" onClick={onClose} aria-label="Close vessel details"><X size={16} /></button>
      <div className="inspection-time"><Ship size={15} /> Vessel</div>
      <div className="inspection-primary"><span>Name</span><strong>{vessel.name || 'Not reported'}</strong></div>
      <div className="inspection-row"><span>MMSI</span><b>{vessel.mmsi}</b></div>
      <div className="inspection-row"><span>Type</span><b>{vesselTypeLabel(vessel.type)}</b></div>
      <div className="inspection-row"><span>Speed</span><b>{vessel.speed.toFixed(1)} knots</b></div>
      <div className="inspection-row"><span>Course</span><b>{vessel.course.toFixed(0)}°</b></div>
      <div className="inspection-row"><span>Heading</span><b>{vessel.heading ? `${vessel.heading.toFixed(0)}°` : 'Not reported'}</b></div>
      <div className="inspection-row"><span>Status</span><b>{navStatusLabel(vessel.navStatus)}</b></div>
      <div className="inspection-row"><span>Position</span><b>{vessel.latitude.toFixed(4)}°, {vessel.longitude.toFixed(4)}°</b></div>
      <div className="inspection-row"><span>Last Update</span><b>{vessel.lastUpdate || 'Unknown'}</b></div>
      <div className="inspection-row"><span>Source</span><b>{vessel.source || 'AIS'}</b></div>
      <small>Vessel data: Open Waters AIS aggregator (near-real-time, terrestrial receivers). Destination/ETA not available from this source.</small>
    </section>
  )
}
