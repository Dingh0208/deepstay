import { create } from 'zustand'

export const usePlansDialog = create(() => ({ open: false }))

export const openPlans = () => usePlansDialog.setState({ open: true })
export const closePlans = () => usePlansDialog.setState({ open: false })
