import { create } from 'zustand'

export const useCharacterDialog = create(() => ({ open: false }))
export const openCharacters = () => useCharacterDialog.setState({ open: true })
export const closeCharacters = () => useCharacterDialog.setState({ open: false })
