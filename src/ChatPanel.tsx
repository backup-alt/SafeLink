import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, MessageCircle, Send, Square, Trash2, X } from 'lucide-react'
import { clearConversation, createConversation, streamChat } from './chatApi'
import type { ChatMessage, ChatStreamEvent, MapAction, MapContext, ToolActivity } from './chatTypes'
import { safeWebURL } from './chatTypes'
import './chat.css'

function answerText(message: ChatMessage) {
  const chunks = []; let cursor = 0
  for (const citation of [...message.citations].sort((a, b) => a.start - b.start)) {
    if (citation.start < cursor || citation.end > message.text.length || !safeWebURL(citation.url)) continue
    chunks.push(message.text.slice(cursor, citation.start))
    chunks.push(<a key={`${citation.start}-${citation.url}`} href={citation.url} target="_blank" rel="noopener noreferrer" title={citation.title}>{message.text.slice(citation.start, citation.end) || '[Source]'}</a>)
    cursor = citation.end
  }
  chunks.push(message.text.slice(cursor))
  return chunks
}

export default function ChatPanel({ context, onMapAction }: { context: MapContext; onMapAction: (action: MapAction, signal: AbortSignal) => Promise<string> }) {
  const [open, setOpen] = useState(false), [input, setInput] = useState(''), [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([]), [notice, setNotice] = useState<string | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const conversation = useRef<string | null>(null), abort = useRef<AbortController | null>(null)
  const scroll = useRef<HTMLDivElement>(null), atBottom = useRef(true)
  const actions = useRef<Promise<unknown>>(Promise.resolve())
  const contextRef = useRef(context), actionRef = useRef(onMapAction)
  contextRef.current = context; actionRef.current = onMapAction

  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetch('/api/chat/health', { signal: controller.signal }).then(r => r.json()).then((data: { configured: boolean }) => setConfigured(data.configured)).catch(() => setConfigured(false))
    return () => controller.abort()
  }, [open])
  useEffect(() => { if (atBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [messages, open])

  const patch = (id: string, update: (message: ChatMessage) => ChatMessage) => setMessages(prev => prev.map(m => m.id === id ? update(m) : m))
  const activity = (id: string, value: ToolActivity) => patch(id, m => ({ ...m, activities: [...m.activities.filter(a => a.id !== value.id), value] }))

  const send = async (text: string) => {
    if (!text.trim() || abort.current) return
    const controller = new AbortController(); abort.current = controller
    const requestContext = contextRef.current
    setBusy(true); setInput(''); setNotice(null); atBottom.current = true
    const id = crypto.randomUUID()
    const base = { text: '', activities: [], sources: [], citations: [], state: 'done' as const }
    setMessages(prev => [...prev.slice(-38), { ...base, id: crypto.randomUUID(), role: 'user', text }, { ...base, id, role: 'assistant', state: 'streaming' }])
    const handle = (event: ChatStreamEvent) => {
      if (controller.signal.aborted) return
      switch (event.type) {
        case 'text_delta': patch(id, m => ({ ...m, text: m.text + event.text })); break
        case 'status': activity(id, { id: 'status', label: event.label, state: 'running' }); break
        case 'tool_start': case 'tool_result': activity(id, { id: event.id, tool: event.tool, label: event.label, source: event.source,
          state: event.type === 'tool_start' ? 'running' : event.success ? 'done' : 'failed' }); break
        case 'web_search_start': activity(id, { id: event.id, label: event.label, state: 'running', source: 'Web' }); break
        case 'web_search_result':
          activity(id, { id: event.id, label: `${event.source_count} web sources found`, state: event.success ? 'done' : 'failed', source: 'Web' })
          patch(id, m => ({ ...m, sources: [...m.sources, ...event.sources].filter((s, i, a) => a.findIndex(x => x.url === s.url) === i) })); break
        case 'citation': patch(id, m => ({ ...m, citations: [...m.citations, event], sources: [...m.sources.filter(s => s.url !== event.url), { url: event.url, title: event.title }] })); break
        case 'map_action':
          actions.current = actions.current.then(async () => {
            if (controller.signal.aborted) return
            const result = await actionRef.current(event.action, controller.signal)
            activity(id, { id: `map-${crypto.randomUUID()}`, label: result, state: 'done', source: 'Map' })
          }).catch(() => activity(id, { id: `map-${crypto.randomUUID()}`, label: 'Map action unavailable; the map is unchanged.', state: 'failed' })); break
        case 'done': patch(id, m => ({ ...m, state: 'done', activities: m.activities.filter(a => a.id !== 'status') })); break
        case 'error': patch(id, m => ({ ...m, state: 'error', error: event.label, activities: m.activities.filter(a => a.id !== 'status').map(a => a.state === 'running' ? { ...a, state: 'failed' } : a) })); break
      }
    }
    try {
      if (!conversation.current) conversation.current = (await createConversation(controller.signal)).conversation_id
      await streamChat({ conversation_id: conversation.current, message: text, map_context: requestContext }, controller.signal, handle)
      await actions.current
    } catch (error) {
      patch(id, m => ({ ...m, state: controller.signal.aborted ? 'stopped' : 'error',
        error: controller.signal.aborted ? 'Stopped. Partial answer may be incomplete.' : error instanceof Error ? error.message : 'Reply unavailable.',
        activities: m.activities.map(a => a.state === 'running' ? { ...a, state: 'failed' } : a) }))
    } finally { if (abort.current === controller) { abort.current = null; setBusy(false) } }
  }
  const clear = async () => {
    if (busy) return
    const id = conversation.current; conversation.current = null
    setMessages([]); setNotice(null)
    if (id) try { await clearConversation(id) } catch { setNotice('New conversation started. The previous server session will expire automatically.') }
  }

  return <>
    {!open && <button className="safelink-launch glass" onClick={() => setOpen(true)} type="button"><MessageCircle size={18} /> Ask SafeLink {busy && <LoaderCircle className="spin" size={14} />}</button>}
    <aside className={`safelink-chat glass ${open ? 'is-open' : ''}`} aria-label="SafeLink marine assistant" hidden={!open}>
      <header className="safelink-chat-header"><div><b>SAFELINK</b><small>Marine information assistant</small></div>
        <button type="button" onClick={() => void clear()} disabled={busy} aria-label="New conversation"><Trash2 size={17} /></button>
        <button type="button" onClick={() => setOpen(false)} aria-label="Collapse SafeLink chat"><X size={19} /></button>
      </header>
      <div className="safelink-context">{context.clicked_location ? `Selected point: ${context.clicked_location.latitude.toFixed(3)}°, ${context.clicked_location.longitude.toFixed(3)}°` : 'Using map view · click a point for “here”'} · {context.active_layer}</div>
      {configured === false && <div className="safelink-notice" role="status">Chat is unavailable or not configured. The map still works. Add the selected provider's API key in backend settings.</div>}
      {notice && <div className="safelink-notice">{notice}</div>}
      <div className="safelink-messages" ref={scroll} onScroll={() => { const el = scroll.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {!messages.length && <div className="safelink-welcome"><h2>Explore with evidence.</h2><p>Ask about a selected point, official PFZ advisories, or ocean conditions. I can update the map while explaining the data.</p>
          {['Find the nearest PFZ from the selected point.', 'What are the wave conditions here?', 'Check current official marine warnings for this area.'].map(q => <button type="button" key={q} onClick={() => setInput(q)}>{q}</button>)}
          <small>Your message and compact map context are sent to the configured AI provider when you send. No continuous location tracking.</small>
        </div>}
        {messages.map((message, index) => <article className={`safelink-message ${message.role}`} key={message.id}>
          <div className="safelink-message-role">{message.role === 'user' ? 'You' : 'SafeLink'}{message.state === 'streaming' && <span role="status">Working…</span>}</div>
          {message.activities.length > 0 && <details className="safelink-activity" open={message.state === 'streaming' ? true : undefined}>
            <summary><ChevronDown size={13} /> Sources & actions · {message.activities.filter(a => a.id !== 'status').length}</summary>
            {message.activities.map(a => <div key={a.id}>{a.state === 'running' ? <LoaderCircle size={13} className="spin" /> : a.state === 'done' ? <Check size={13} /> : <span>!</span>}<span>{a.label}{a.source && <small>{a.source}</small>}</span></div>)}
          </details>}
          <div className="safelink-answer">{answerText(message)}</div>
          {message.error && <p className="safelink-error" role="alert">{message.error}</p>}
          {message.sources.length > 0 && <details className="safelink-sources"><summary>Web sources · {message.sources.length}</summary>{message.sources.map(s => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>)}</details>}
          {['error', 'stopped'].includes(message.state) && !busy && <button className="safelink-retry" type="button" onClick={() => void send(messages[index - 1]?.text ?? '')}>Retry</button>}
        </article>)}
      </div>
      <form className="safelink-compose" onSubmit={e => { e.preventDefault(); void send(input) }}>
        <textarea aria-label="Message SafeLink" placeholder="Ask about this point or a PFZ…" maxLength={4000} value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input) } }} />
        {busy ? <button type="button" aria-label="Stop generation" onClick={() => abort.current?.abort()}><Square size={18} /></button>
          : <button type="submit" aria-label="Send message" disabled={!input.trim()}><Send size={18} /></button>}
      </form>
      <footer>Advisory information—not certified navigation or safety guidance.</footer>
    </aside>
  </>
}
