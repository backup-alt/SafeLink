import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, History, LoaderCircle, MessageCircle, Plus, Send, Square, Trash2, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { acknowledgeMapAction, clearConversation, createConversation, getHistory, historyStorage, listConversations, streamChat } from './chatApi'
import type { SavedConversation, HistoryStorage } from './chatApi'
import type { ChatMessage, ChatStreamEvent, MapAction, MapContext, ToolActivity } from './chatTypes'
import { safeWebURL } from './chatTypes'
import './chat.css'

function answerText(message: ChatMessage) {
  if (message.role === 'user') return message.text
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => safeWebURL(url) ? url : ''}
    components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: () => null }}>{message.text}</Markdown>
}

export default function ChatPanel({ context, onMapAction }: { context: MapContext; onMapAction: (action: MapAction, signal: AbortSignal) => Promise<string> }) {
  const [open, setOpen] = useState(false), [input, setInput] = useState(''), [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([]), [notice, setNotice] = useState<string | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [saved, setSaved] = useState<SavedConversation[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [storage, setStorage] = useState<HistoryStorage>({ configured: false, enabled: false })
  const conversation = useRef<string | null>(null), abort = useRef<AbortController | null>(null)
  const scroll = useRef<HTMLDivElement>(null), atBottom = useRef(true)
  const actions = useRef<Promise<unknown>>(Promise.resolve())
  const contextRef = useRef(context), actionRef = useRef(onMapAction)
  contextRef.current = context; actionRef.current = onMapAction

  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    if (!open) return
    historyStorage().then(setStorage).catch(() => undefined)
    const controller = new AbortController()
    fetch('/api/chat/health', { signal: controller.signal }).then(r => r.json()).then((data: { configured: boolean }) => setConfigured(data.configured)).catch(() => setConfigured(false))
    return () => controller.abort()
  }, [open])
  useEffect(() => { if (atBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }) }, [messages, open])

  const patch = (id: string, update: (message: ChatMessage) => ChatMessage) => setMessages(prev => prev.map(m => m.id === id ? update(m) : m))
  const activity = (id: string, value: ToolActivity) => patch(id, m => ({ ...m, activities: [...m.activities.filter(a => a.id !== value.id), value] }))

  const send = async (text: string) => {
    if (!text.trim() || abort.current || historyLoading) return
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
        case 'sources': patch(id, m => ({ ...m, sources: [...m.sources, ...event.sources].filter((s, i, a) => a.findIndex(x => x.url === s.url) === i) })); break
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
            try {
              const result = await actionRef.current(event.action, controller.signal)
              if (event.id && conversation.current) await acknowledgeMapAction(conversation.current, event.id, 'accepted', controller.signal)
              activity(id, { id: `map-${crypto.randomUUID()}`, label: result, state: 'done', source: 'Map' })
            } catch (error) {
              if (event.id && conversation.current && !controller.signal.aborted) await acknowledgeMapAction(conversation.current, event.id, 'failed', controller.signal).catch(() => undefined)
              throw error
            }
          }).catch(() => activity(id, { id: `map-${crypto.randomUUID()}`, label: 'Map action unavailable; the map is unchanged.', state: 'failed' })); break
        case 'done': patch(id, m => ({ ...m, state: 'done', activities: m.activities.filter(a => a.id !== 'status') })); break
        case 'error': patch(id, m => ({ ...m, state: 'error', error: event.label, activities: m.activities.filter(a => a.id !== 'status').map(a => a.state === 'running' ? { ...a, state: 'failed' } : a) })); break
      }
    }
    try {
      if (!conversation.current) conversation.current = (await createConversation(controller.signal)).conversation_id
      await streamChat({ conversation_id: conversation.current, message: text, map_context: requestContext }, controller.signal, handle)
      await actions.current
      if (storage.enabled) {
        try {
          const snapshot = await getHistory(conversation.current)
          if (snapshot.archive_error || !snapshot.archived) setNotice('Reply is available, but cloud history was not saved. Keep this page open and retry later.')
        } catch { setNotice('Reply is available, but cloud history could not be verified. Keep this page open.') }
      }
    } catch (error) {
      patch(id, m => ({ ...m, state: controller.signal.aborted ? 'stopped' : 'error',
        error: controller.signal.aborted ? 'Stopped. Partial answer may be incomplete.' : error instanceof Error ? error.message : 'Reply unavailable.',
        activities: m.activities.map(a => a.state === 'running' ? { ...a, state: 'failed' } : a) }))
    } finally { if (abort.current === controller) { abort.current = null; setBusy(false) } }
  }
  const clear = async () => {
    if (busy) return
    conversation.current = null
    setMessages([]); setNotice(null); setHistoryOpen(false)
  }

  const loadHistory = async () => {
    setHistoryOpen(true); setHistoryLoading(true)
    try {
      setSaved(await listConversations())
    } catch { setNotice('Could not load conversation history. Please retry.') }
    finally { setHistoryLoading(false) }
  }
  const resume = async (id: string) => {
    if (busy || historyLoading) return
    setHistoryLoading(true)
    try {
      const history = await getHistory(id)
      conversation.current = id
      setMessages(history.messages.map(m => ({ id: crypto.randomUUID(), role: m.role, text: m.content,
        activities: m.activities ?? [], sources: m.sources ?? [], citations: [], state: m.role === 'user' || m.complete ? 'done' : 'stopped',
        error: m.error ?? (m.role === 'assistant' && !m.complete ? 'This reply was interrupted and may be incomplete.' : undefined) })))
      setHistoryOpen(false); setNotice('Conversation reopened. Earlier map actions are not replayed.'); atBottom.current = true
    } catch { setNotice('This conversation is unavailable or still generating. Refresh history and try again.') }
    finally { setHistoryLoading(false) }
  }
  const remove = async (id: string) => {
    if (busy || historyLoading) return
    setHistoryLoading(true)
    try {
      await clearConversation(id)
      if (conversation.current === id) { conversation.current = null; setMessages([]) }
      setSaved(previous => previous.filter(item => item.conversation_id !== id))
    } catch { setNotice('Could not delete this conversation. Please retry.') }
    finally { setHistoryLoading(false) }
  }
  const toggleStorage = async (enabled: boolean) => {
    if (busy || historyLoading) return
    setHistoryLoading(true)
    try {
      setStorage(await historyStorage(enabled))
      setNotice(enabled ? 'Private archive enabled for this browser. Keep its cookies to retain access.' : 'Future cloud saves disabled. Existing cloud versions are retained; use Delete to remove a chat from the current archive.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not update storage preference.') }
    finally { setHistoryLoading(false) }
  }

  return <>
    {!open && <button className="safelink-launch glass" onClick={() => setOpen(true)} type="button"><MessageCircle size={18} /> Ask SafeLink {busy && <LoaderCircle className="spin" size={14} />}</button>}
    <aside className={`safelink-chat glass ${open ? 'is-open' : ''}`} aria-label="SafeLink marine assistant" hidden={!open}>
      <header className="safelink-chat-header"><div><b>SAFELINK</b><small>Marine information assistant</small></div>
        <button type="button" onClick={() => historyOpen ? setHistoryOpen(false) : void loadHistory()} disabled={busy || historyLoading} aria-label="View history" title="View conversation history"><History size={17} /></button>
        <button type="button" onClick={() => void clear()} disabled={busy || historyLoading} aria-label="New conversation"><Plus size={17} /></button>
        <button type="button" onClick={() => setOpen(false)} aria-label="Collapse SafeLink chat"><X size={19} /></button>
      </header>
      <div className="safelink-context">{context.clicked_location ? `Selected point: ${context.clicked_location.latitude.toFixed(3)}°, ${context.clicked_location.longitude.toFixed(3)}°` : 'Using map view - click a point for "here"'} - {context.active_layer}</div>
      {configured === false && <div className="safelink-notice" role="status">Chat is unavailable or not configured. The map still works. Add the selected provider's API key in backend settings.</div>}
      {notice && <div className="safelink-notice">{notice}</div>}
      {historyOpen && (
        <div className="safelink-history-panel">
          <div className="safelink-history-header">
            <strong>Conversation History</strong>
            <button type="button" onClick={() => setHistoryOpen(false)} aria-label="Close history"><X size={16} /></button>
          </div>
          <div className="safelink-history-info">
            {storage.configured && <label><input type="checkbox" checked={storage.enabled} disabled={busy || historyLoading} onChange={e => void toggleStorage(e.target.checked)} /> Save my chats in the private Hugging Face archive</label>}
            <p>{storage.enabled ? 'Saved chats survive server restarts. Access uses this browser cookie (up to one year); clearing cookies loses access. Messages may contain locations. The dataset owner can read them. Delete removes a chat from the current archive, not older repository versions.' : 'Temporary chats expire after 2 hours of inactivity or server restart. Opt-in cloud storage, when configured, sends chat content to a private dataset.'} The assistant retains limited recent context.</p>
            {historyLoading && <p role="status">Loading…</p>}
            {!historyLoading && !saved.length && <p>No saved conversations.</p>}
            {saved.map(item => <div className="safelink-history-row" key={item.conversation_id}>
              <button type="button" disabled={busy || historyLoading || item.busy} onClick={() => void resume(item.conversation_id)}>{item.title}<small>{item.turns} turns{item.busy ? ' · Working…' : ''}</small></button>
              <button type="button" disabled={busy || historyLoading || item.busy} onClick={() => void remove(item.conversation_id)} aria-label={`Delete ${item.title}`}><Trash2 size={15} /></button>
            </div>)}
          </div>
        </div>
      )}
      <div className="safelink-messages" ref={scroll} onScroll={() => { const el = scroll.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {!messages.length && <div className="safelink-welcome"><h2>Explore with evidence.</h2><p>Ask about a selected point, official PFZ advisories, or ocean conditions. I can update the map while explaining the data.</p>
          {['Find the nearest PFZ from the selected point.', 'What are the wave conditions here?', 'Check current official marine warnings for this area.'].map(q => <button type="button" key={q} onClick={() => setInput(q)}>{q}</button>)}
          <small>Your message and compact map context are sent to the configured AI provider when you send. No continuous location tracking.</small>
        </div>}
        {messages.map((message, index) => <article className={`safelink-message ${message.role}`} key={message.id}>
          <div className="safelink-message-role">{message.role === 'user' ? 'You' : 'SafeLink'}{message.state === 'streaming' && <span role="status">Working...</span>}</div>
          {message.activities.length > 0 && <details className="safelink-activity" open={message.state === 'streaming' ? true : undefined}>
            <summary><ChevronDown size={13} /> Steps performed · {message.activities.filter(a => a.id !== 'status').length}</summary>
            {message.activities.map(a => <div key={a.id}>{a.state === 'running' ? <LoaderCircle size={13} className="spin" /> : a.state === 'done' ? <Check size={13} /> : <span>!</span>}<span>{a.label}{a.source && <small>{a.source}</small>}</span></div>)}
          </details>}
          <div className="safelink-answer">{answerText(message)}</div>
          {message.error && <p className="safelink-error" role="alert">{message.error}</p>}
          {message.sources.length > 0 && <details className="safelink-sources"><summary>Sources · {message.sources.length}</summary>{message.sources.filter(s => safeWebURL(s.url)).map(s => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>)}</details>}
          {['error', 'stopped'].includes(message.state) && !busy && <button className="safelink-retry" type="button" onClick={() => void send(messages[index - 1]?.text ?? '')}>Retry</button>}
        </article>)}
      </div>
      <form className="safelink-compose" onSubmit={e => { e.preventDefault(); void send(input) }}>
        <textarea aria-label="Message SafeLink" placeholder="Ask about this point or a PFZ..." maxLength={4000} value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input) } }} />
        {busy ? <button type="button" aria-label="Stop generation" onClick={() => abort.current?.abort()}><Square size={18} /></button>
          : <button type="submit" aria-label="Send message" disabled={!input.trim() || historyLoading}><Send size={18} /></button>}
      </form>
      <footer>Advisory information-not certified navigation or safety guidance.</footer>
    </aside>
  </>
}
