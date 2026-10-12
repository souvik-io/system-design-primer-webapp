import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** `vite preview` serves the empty app shell for app routes without a prerendered page, as vercel.json does. */
function appShellInPreview(): Plugin {
  return {
    name: 'app-shell-in-preview',
    configurePreviewServer(server) {
      const dist = path.resolve(server.config.root, server.config.build.outDir)
      server.middlewares.use((req, _res, next) => {
        const url = (req.url ?? '/').split('?')[0]
        const isFile = path.extname(url) !== ''
        if (url !== '/' && !isFile && !fs.existsSync(path.join(dist, `${url}.html`)) && fs.existsSync(path.join(dist, 'app.html'))) req.url = '/app.html'
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), appShellInPreview()],
})
