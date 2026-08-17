import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative, so the packaged renderer loads over file:// inside Electron.
  base: "./",
  plugins: [react()],
})
