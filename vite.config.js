import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import ytProxy from './server/ytproxy.js'

export default defineConfig({
  plugins: [react(), ytProxy()],
})
