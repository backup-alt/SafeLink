import type { ChatRequest, ChatStreamEvent, ConversationState } from './chatTypes'
import { parseChatEvent } from './chatTypes'

async function checked(response: Response) {
  if (!response.ok) {
    const labels: Record<number, string> = {
      401: 'Browser session unavailable. Start a new conversation.', 403: 'This chat request was blocked.',
      404: 'Conversation expired. Start a new conversation.', 409: 'The previous reply is still stopping. Try again shortly.',
      422: 'Please check your message or map selection.', 429: 'SafeLink usage limit reached or service busy. Try later, or start a new conversation if this one is long.',
      503: 'SafeLink AI is not configured. Check the server AI provider and its API key. The map remains available.',
      502: 'Private chat storage is unavailable. Check that the separate dataset is private and its token has access. Your local conversation has not been cleared.',
    }
    throw new Error(labels[response.status] ?? 'SafeLink is temporarily unavailable. Please retry.')
  }
  return response
}
export async function createConversation(signal?: AbortSignal): Promise<ConversationState> {
  const response = await checked(await fetch('/api/chat/session', { method: 'POST', signal }))
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object' || !('conversation_id' in result) || typeof result.conversation_id !== 'string') throw new Error('Invalid session response')
  return { conversation_id: result.conversation_id }
}
export async function clearConversation(id: string) {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (response.status !== 404) await checked(response)
}
export type SavedConversation = { conversation_id: string; title: string; turns: number; busy: boolean }
export type HistoryStorage = { configured: boolean; enabled: boolean }
export async function historyStorage(enabled?: boolean): Promise<HistoryStorage> {
  const response = await checked(await fetch('/api/chat/history-storage', enabled === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  }))
  return response.json()
}
export async function listConversations(): Promise<SavedConversation[]> {
  const response = await checked(await fetch('/api/chat/sessions', { cache: 'no-store' }))
  return (await response.json()).conversations
}
export async function getHistory(id: string): Promise<{ messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number; complete?: boolean; error?: string; activities?: import('./chatTypes').ToolActivity[]; sources?: import('./chatTypes').WebSource[] }>; turns: number; archived?: boolean; archive_error?: boolean }> {
  const response = await checked(await fetch(`/api/chat/session/${encodeURIComponent(id)}/history`))
  return await response.json()
}
export async function acknowledgeMapAction(conversation: string, action: string, status: 'accepted' | 'failed', signal: AbortSignal) {
  await checked(await fetch(`/api/chat/session/${encodeURIComponent(conversation)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }), signal,
  }))
}
export async function streamChat(request: ChatRequest, signal: AbortSignal, onEvent: (event: ChatStreamEvent) => void) {
  const response = await checked(await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }))
  if (!response.body) throw new Error('Streaming is unavailable in this browser.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', ended = false
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n')
      if (buffer.length > 100000) throw new Error('Chat stream exceeded its size limit.')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const data = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const event = parseChatEvent(JSON.parse(data))
        onEvent(event)
        if (event.type === 'done' || event.type === 'error') ended = true
      }
      if (chunk.done) break
    }
    if (!ended) throw new Error('Connection ended before the reply finished. You can retry.')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
