import { useEffect, useState, useRef } from 'react'

export default function GuardrailBanner({ point }: { point: [number, number] | null }) {
  const [data, setData] = useState<any>(null)
  const audioRef = useRef<AudioContext | null>(null)
  const prevLevel = useRef<string | null>(null)

  useEffect(() => {
    if (!point) { setData(null); return }
    const [lng, lat] = point
    let cancelled = false
    fetch(`/api/alerts/guardrail?latitude=${lat}&longitude=${lng}`)
      .then(r => r.json()).then(d => { if (!cancelled) setData(d) }).catch(() => {})
    const id = setInterval(() => {
      fetch(`/api/alerts/guardrail?latitude=${lat}&longitude=${lng}`).then(r => r.json()).then(d => { if (!cancelled) setData(d) }).catch(() => {})
    }, 15000)
    return () => { cancelled = true; clearInterval(id) }
  }, [point?.[0], point?.[1]])

  useEffect(() => {
    if (!data || data.level === prevLevel.current) return
    prevLevel.current = data.level
    if (data.level === 'danger' || data.level === 'warning') {
      try {
        if (!audioRef.current) audioRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
        const ctx = audioRef.current
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.frequency.value = data.level === 'danger' ? 880 : 440
        o.connect(g)
        g.connect(ctx.destination)
        g.gain.value = data.level === 'danger' ? 0.3 : 0.15
        o.start()
        setTimeout(() => { o.stop() }, data.level === 'danger' ? 500 : 300)
      } catch {}
      try { navigator.vibrate?.(data.level === 'danger' ? [400, 100, 400, 100, 400] : [200]) } catch {}
      try {
        if (Notification && Notification.permission === 'granted') {
          new Notification('SafeLink Guardrail', {
            body: data.alerts[0]?.message || `${data.level.toUpperCase()} zone detected`,
            icon: '/favicon.ico',
            tag: 'safelink-guardrail',
          })
        } else if (Notification && Notification.permission !== 'denied') {
          Notification.requestPermission().then(perm => {
            if (perm === 'granted') {
              new Notification('SafeLink Guardrail', {
                body: data.alerts[0]?.message || `${data.level.toUpperCase()} zone detected`,
                icon: '/favicon.ico',
                tag: 'safelink-guardrail',
              })
            }
          })
        }
      } catch {}
    }
  }, [data?.level, data?.checked_at])

  if (!point || !data) return null
  const isDanger = data.level === 'danger'
  const isWarning = data.level === 'warning'
  const color = isDanger ? '#ff3b30' : isWarning ? '#ffcc00' : '#34c759'
  const bg = isDanger ? 'rgba(255,59,48,0.18)' : isWarning ? 'rgba(255,204,0,0.18)' : 'rgba(52,199,89,0.15)'

  return (
    <div style={{
      position: 'absolute',
      top: 64,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 20,
      background: bg,
      border: `2px solid ${color}`,
      borderRadius: 12,
      padding: '12px 20px',
      minWidth: 340,
      maxWidth: 480,
      backdropFilter: 'blur(12px)',
      boxShadow: isDanger ? `0 0 20px ${color}55, 0 0 60px ${color}22` : `0 4px 16px rgba(0,0,0,0.3)`,
      animation: isDanger ? 'guardrail-pulse 1.2s ease-in-out infinite' : 'none',
    }}>
      <style>{`
        @keyframes guardrail-pulse {
          0%, 100% { box-shadow: 0 0 20px ${color}55, 0 0 60px ${color}22; }
          50% { box-shadow: 0 0 30px ${color}88, 0 0 80px ${color}44; }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color, fontSize: 15 }}>
        {isDanger ? '🔴' : isWarning ? '🟡' : '🟢'} {isDanger ? 'DANGER' : isWarning ? 'WARNING' : 'SAFE'} - {isDanger ? 'Immediate Action Required' : isWarning ? 'Caution Advised' : 'Guardrail Active'}
      </div>
      <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>
        {data.alerts.length ? data.alerts.map((a: any, i: number) => (
          <div key={i}>⚠️ <b>{a.type}</b>: {a.message}</div>
        )) : 'No hazards at this position.'}
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
        Wave: {data.samples.wave.value ?? '—'} {data.samples.wave.unit} | Chl: {data.samples.chlorophyll.value ?? '—'} mg/m³ age {data.samples.chlorophyll.age_hours ?? '—'}h | Ships: {data.samples.ship_count}
      </div>
      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
        Checked {new Date(data.checked_at).toLocaleTimeString()} at {point[1].toFixed(3)}, {point[0].toFixed(3)}
      </div>
    </div>
  )
}
