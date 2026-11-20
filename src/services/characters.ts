import { create } from 'zustand'
import { createId } from '../utils/id.js'
import * as db from './chat/db.js'

export type CharacterPreset = {
  id: string
  name: string
  prompt: string
  greeting: string
  updatedAt: number
}

export type CharacterSnapshot = {
  presetId: string
  name: string
  prompt: string
  greeting?: string
}

type CharacterInput = Pick<CharacterPreset, 'name' | 'prompt' | 'greeting'> & { id?: string }

export const characterLimits = { name: 100, prompt: 20_000, greeting: 10_000, id: 200 } as const

/** Character text is copied into each new session, independently of later library edits. */
export const characterSnapshot = (preset: CharacterPreset): CharacterSnapshot => ({
  presetId: preset.id,
  name: preset.name,
  prompt: preset.prompt,
  ...(preset.greeting ? { greeting: preset.greeting } : {}),
})

export const characterSystemPrompt = (base: string, character?: CharacterSnapshot): string =>
  character ? [
    base,
    `你将扮演以下人物。人物名称：${character.name}\n${character.prompt}`,
    ...(character.greeting ? [`本次对话已经向用户展示的开场白：\n${character.greeting}`] : []),
  ].filter(Boolean).join('\n\n') : base

export const useCharacters = create<{
  presets: CharacterPreset[]
  ready: boolean
  error: boolean
}>(() => ({ presets: [], ready: false, error: false }))

const sortPresets = (presets: CharacterPreset[]) =>
  [...presets].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}

let loading: Promise<void> | undefined
export const loadCharacters = (): Promise<void> => {
  if (loading) {
    return loading
  }
  loading = enqueue(async () => {
    try {
      const presets = await db.loadCharacterPresets()
      useCharacters.setState({ presets: sortPresets(presets), ready: true, error: false })
    } catch (error) {
      useCharacters.setState({ error: true })
      db.reportStorageError('load character presets')(error)
      throw error
    }
  }).finally(() => { loading = undefined })
  return loading
}

const validateInput = (value: CharacterInput) => {
  const { id } = value
  const name = value.name.trim()
  const prompt = value.prompt.trim()
  const greeting = value.greeting.trim()
  if (!name || name.length > characterLimits.name || !prompt || prompt.length > characterLimits.prompt ||
      greeting.length > characterLimits.greeting || (id !== undefined && (!id.trim() || id.length > characterLimits.id))) {
    throw new Error('Invalid character preset')
  }
  return { id, name, prompt, greeting }
}

export const saveCharacter = async (input: CharacterInput): Promise<CharacterPreset> => {
  const value = validateInput(input)
  if (!useCharacters.getState().ready) {
    await loadCharacters()
  }
  return enqueue(async () => {
    const preset: CharacterPreset = { ...value, id: value.id ?? createId(), updatedAt: Date.now() }
    try {
      await db.saveCharacterPreset(preset)
      useCharacters.setState((state) => ({
        presets: sortPresets([preset, ...state.presets.filter((entry) => entry.id !== preset.id)]),
        error: false,
      }))
      return preset
    } catch (error) {
      useCharacters.setState({ error: true })
      db.reportStorageError('save character preset')(error)
      throw error
    }
  })
}

export const deleteCharacter = async (id: string): Promise<void> => {
  if (!useCharacters.getState().ready) {
    await loadCharacters()
  }
  return enqueue(async () => {
    try {
      await db.deleteCharacterPreset(id)
      useCharacters.setState((state) => ({ presets: state.presets.filter((entry) => entry.id !== id), error: false }))
    } catch (error) {
      useCharacters.setState({ error: true })
      db.reportStorageError('delete character preset')(error)
      throw error
    }
  })
}
