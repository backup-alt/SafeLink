import type { ChatRequest, ChatStreamEvent, ConversationState } from './chatTypes'
import { parseChatEvent } from './chatTypes'

async function checked(response: Response) {
  if (!response.ok) {
    const labels: Record<number, string> = {
      401: 'Browser session unavailable. Start a new conversation.', 403: 'This chat request was blocked.',
      404: 'Conversation expired. Start a new conversation.', 409: 'The previous reply is still stopping. Try again shortly.',
      422: 'Please check your message or map selection.', 429: 'ORCA usage limit reached or service busy. Try later, or start a new conversation if this one is long.',
      503: 'ORCA is not configured. Add the server OpenAI API key and valid AI settings. The map remains available.',
    }
    throw new Error(labels[response.status] ?? 'ORCA is temporarily unavailable. Please retry.')
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
