import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type SettingsState = {
  /** Show the chapters written for this site, beyond the primer itself */
  showExtras: boolean
  setShowExtras: (show: boolean) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      showExtras: false,
      setShowExtras: (showExtras) => set({ showExtras }),
    }),
    { name: 'sdp-settings', version: 1 },
  ),
)
