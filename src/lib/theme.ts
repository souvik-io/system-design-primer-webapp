import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'sdp-theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* storage unavailable */
  }
  return 'system'
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice)

  useEffect(() => {
    apply(choice)
    try {
      localStorage.setItem(KEY, choice)
    } catch {
      /* storage unavailable */
    }
    if (choice !== 'system') return
    const onChange = () => apply('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [choice])

  const isDark = choice === 'dark' || (choice === 'system' && media.matches)
  return { choice, isDark, toggle: () => setChoice(isDark ? 'light' : 'dark') }
}
