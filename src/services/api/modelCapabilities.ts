import type { CreateMessageRequest, MessageParam } from './types.js'

const isDeepSeekV4Pro = (model: string) => /^(?:deepseek-v4-pro(?:$|-)|claude-opus)/i.test(model)

/** V4 Pro uses Anthropic's standard web search tool. */
export const usesAnthropicWebSearch = (model: string): boolean => isDeepSeekV4Pro(model)

export const supportsDeepSeekTitles = (model: string): boolean => !isDeepSeekV4Pro(model)

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
