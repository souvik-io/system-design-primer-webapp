interface ImportMetaEnv {
  /** Where progress is kept: "browser" (default) or "supabase" */
  readonly VITE_PROGRESS_STORAGE?: 'browser' | 'supabase' | (string & {})
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
}
