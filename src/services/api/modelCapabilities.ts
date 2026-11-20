import type { CreateMessageRequest, MessageParam } from './types.js'

/** DeepSeek documents Pro (including its Opus aliases) as lacking server tools and titles. */
export const supportsDeepSeekServerTools = (model: string): boolean =>
  !/^(?:deepseek-v4-pro(?:$|-)|claude-opus)/i.test(model)

export const adaptDeepSeekRequest = (body: CreateMessageRequest): CreateMessageRequest => {
  if (supportsDeepSeekServerTools(body.model)) {
    return body
  }
  const request = { ...body }
  delete request.title
  return {
    ...request,
    tools: [],
    messages: body.messages.flatMap<MessageParam>((message) => {
      if (message.role !== 'assistant') {
        return [message]
      }
      const content = message.content.filter((block) => block.type === 'text' || block.type === 'thinking')
      return content.length ? [{ ...message, content }] : []
    }),
  }
}
