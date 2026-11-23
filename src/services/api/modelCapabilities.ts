import type { CreateMessageRequest, MessageParam } from './types.js'

const isClaudeOpus = (model: string) => /^claude-opus/i.test(model)

/** DeepSeek Pro/Flash use the upstream demo's DeepSeek tools; keep Claude's compatibility path separate. */
export const usesAnthropicWebSearch = (model: string): boolean => isClaudeOpus(model)

export const supportsDeepSeekTitles = (model: string): boolean => !isClaudeOpus(model)

export const adaptDeepSeekRequest = (body: CreateMessageRequest): CreateMessageRequest => {
  if (supportsDeepSeekTitles(body.model)) {
    return body
  }
  const request = { ...body }
  delete request.title
  return {
    ...request,
    tools: body.tools.filter((tool) => tool.type === 'web_search_20250305'),
    messages: body.messages.flatMap<MessageParam>((message) => {
      if (message.role === 'latest_reminder') {
        return []
      }
      if (message.role !== 'assistant') {
        return [message]
      }
      const content = message.content.filter((block) => block.type === 'text' || block.type === 'thinking')
      return content.length ? [{ ...message, content }] : []
    }),
  }
}
