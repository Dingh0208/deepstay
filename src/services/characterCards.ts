import type { CharacterPreset } from './characters.js'

type CharacterText = Pick<CharacterPreset, 'name' | 'prompt' | 'greeting' | 'alternateGreetings'>
type ImportedCharacter = CharacterText & { warnings: string[] }

const maxFileSize = 20 * 1024 * 1024
const maxJsonSize = 200 * 1024
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
const invalidCard = () => new Error('Invalid or oversized character card')

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidCard()
  }
  return value as Record<string, unknown>
}

const text = (data: Record<string, unknown>, key: string): string => {
  const value = data[key]
  if (value === undefined) {
    return ''
  }
  if (typeof value !== 'string') {
    throw invalidCard()
  }
  return value.trim()
}

const validate = (value: CharacterText): CharacterText => {
  const greetings = [value.greeting, ...(value.alternateGreetings ?? [])]
  if (!value.name || value.name.length > 100 || !value.prompt || value.prompt.length > 20_000 ||
      greetings.length > 100 || greetings.some((text) => text.length > 10_000) ||
      greetings.reduce((sum, text) => sum + text.length, 0) > 100_000) {
    throw invalidCard()
  }
  return value
}

const alternateGreetings = (value: unknown): string[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.some((text) => typeof text !== 'string')) {
    throw invalidCard()
  }
  return value.map((text: string) => text.trim())
}

const parseJson = (bytes: Uint8Array): unknown => {
  if (!bytes.length || bytes.length > maxJsonSize) {
    throw invalidCard()
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

const cardText = (value: unknown): ImportedCharacter => {
  const card = object(value)
  if (card.format !== undefined) {
    if (card.format !== 'deepstay-character' || card.version !== 1) {
      throw invalidCard()
    }
    const alternates = alternateGreetings(card.alternateGreetings)
    return { ...validate({ name: text(card, 'name'), prompt: text(card, 'prompt'), greeting: text(card, 'greeting'),
      ...(alternates.length ? { alternateGreetings: alternates } : {}),
    }), warnings: [] }
  }
  if (card.spec !== undefined && card.spec !== 'chara_card_v2' && card.spec !== 'chara_card_v3') {
    throw invalidCard()
  }
  const data = card.spec === undefined ? card : object(card.data)
  const name = text(data, 'name')
  const nickname = text(data, 'nickname') || name
  if (!name || name.length > 100 || nickname.length > 100) {
    throw invalidCard()
  }
  const expand = (value: string) => value.replace(/\{\{\s*(char|user)\s*\}\}/gi, (_, key: string) => key.toLowerCase() === 'char' ? nickname : '用户')
  const sections = [
    ['system_prompt', '角色指令'],
    ['description', '人物设定'],
    ['personality', '性格'],
    ['scenario', '场景'],
    ['mes_example', '对话示例'],
    ['post_history_instructions', '角色补充约定'],
  ].flatMap(([key, label]) => {
    const value = text(data, key)
    return value ? [`${label}：\n${expand(value)}`] : []
  })
  const alternates = alternateGreetings(data.alternate_greetings).map(expand)
  return {
    ...validate({ name, prompt: sections.join('\n\n'), greeting: expand(text(data, 'first_mes')),
      ...(alternates.length ? { alternateGreetings: alternates } : {}),
    }),
    warnings: ['text-only'],
  }
}

const pngJson = (bytes: Uint8Array): unknown => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let position = pngSignature.length
  let v2: Uint8Array | undefined
  let v3: Uint8Array | undefined
  let ended = false
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position)
    const end = position + 12 + length
    if (end > bytes.length) {
      throw invalidCard()
    }
    const type = String.fromCharCode(...bytes.subarray(position + 4, position + 8))
    if (position === pngSignature.length && (type !== 'IHDR' || length !== 13)) {
      throw invalidCard()
    }
    if (type === 'tEXt') {
      const chunk = bytes.subarray(position + 8, position + 8 + length)
      const separator = chunk.indexOf(0)
      if (separator >= 0 && separator <= 79) {
        const key = String.fromCharCode(...chunk.subarray(0, separator)).toLowerCase()
        if (key === 'ccv3' && !v3) {
          v3 = chunk.subarray(separator + 1)
        } else if (key === 'chara' && !v2) {
          v2 = chunk.subarray(separator + 1)
        }
      }
    }
    position = end
    if (type === 'IEND') {
      if (length !== 0 || position !== bytes.length) {
        throw invalidCard()
      }
      ended = true
      break
    }
  }
  const encoded = v3 ?? v2
  if (!ended || !encoded || encoded.length > Math.ceil(maxJsonSize / 3) * 4) {
    throw invalidCard()
  }
  const base64 = new TextDecoder('ascii').decode(encoded)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw invalidCard()
  }
  const decoded = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
  return parseJson(decoded)
}

export const importCharacterCard = async (file: File): Promise<ImportedCharacter> => {
  if (!file.size || file.size > maxFileSize) {
    throw invalidCard()
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (pngSignature.every((value, index) => bytes[index] === value)) {
    return cardText(pngJson(bytes))
  }
  if (bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4) {
    const { unzipSync } = await import('fflate')
    let size: number | undefined
    const files = unzipSync(bytes, { filter: (entry) => {
      if (entry.name !== 'card.json') {
        return false
      }
      if (size !== undefined || entry.originalSize > maxJsonSize) {
        throw invalidCard()
      }
      size = entry.originalSize
      return true
    } })
    const json = files['card.json']
    if (!json || json.length !== size) {
      throw invalidCard()
    }
    return cardText(parseJson(json))
  }
  return cardText(parseJson(bytes))
}

export const exportCharacterCard = (preset: CharacterText): string => {
  const alternates = alternateGreetings(preset.alternateGreetings)
  const value = validate({ name: preset.name.trim(), prompt: preset.prompt.trim(), greeting: preset.greeting.trim(),
    ...(alternates.length ? { alternateGreetings: alternates } : {}),
  })
  const json = JSON.stringify({ format: 'deepstay-character', version: 1, ...value }, null, 2)
  if (new TextEncoder().encode(json).length > maxJsonSize) {
    throw invalidCard()
  }
  return json
}
