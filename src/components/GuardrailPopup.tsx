import { useEffect, useState, useRef, useCallback } from 'react'

export default function GuardrailPopup({ point, onClose }: { point: [number, number] | null, onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!point) { setData(null); return }
    const [lng, lat] = point
    let cancelled = false
    fetch(`/api/alerts/guardrail?latitude=${lat}&longitude=${lng}`)
      .then(r => r.json()).then(d => { if (!cancelled) setData(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [point?.[0], point?.[1]])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (data) {
      timerRef.current = setTimeout(onClose, 8000)
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [data, onClose])

  if (!point || !data) return null
  const isDanger = data.level === 'danger'
  const isWarning = data.level === 'warning'
  const color = isDanger ? '#ff3b30' : isWarning ? '#ffcc00' : '#34c759'
  const bg = isDanger ? 'rgba(180,20,20,0.92)' : isWarning ? 'rgba(160,130,0,0.92)' : 'rgba(40,140,60,0.92)'

  return (
    <div style={{
      position: 'absolute',
      bottom: 100,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 30,
      background: bg,
      border: `2px solid ${color}`,
      borderRadius: 14,
      padding: '14px 22px',
      minWidth: 300,
      maxWidth: 420,
      color: '#fff',
      backdropFilter: 'blur(12px)',
      boxShadow: `0 0 30px ${color}66, 0 8px 32px rgba(0,0,0,0.5)`,
      animation: 'guardrail-slide 0.3s ease-out',
    }}>
      <style>{`
        @keyframes guardrail-slide {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>
          {isDanger ? '🔴 DANGER ZONE' : isWarning ? '🟡 WARNING ZONE' : '🟢 SAFE ZONE'}
        </div>
        <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}>✕</button>
      </div>
      {data.alerts.map((a: any, i: number) => (
        <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>⚠️ <b>{a.type}</b>: {a.message}</div>
      ))}
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
        Ships nearby: {data.samples.ship_count} | Wave: {data.samples.wave.value ?? '—'} {data.samples.wave.unit}
      </div>
      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>
        {point[1].toFixed(3)}, {point[0].toFixed(3)}
      </div>
    </div>
  )
}
