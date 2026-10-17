import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Cross-origin isolation enables SharedArrayBuffer (A/V clock + PCM shared with the AudioWorklet).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // The editor, plus the hidden Node-enabled export window.
        input: { index: resolve('src/renderer/index.html'), export: resolve('src/renderer/export.html') },
      },
    },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
  },
})
