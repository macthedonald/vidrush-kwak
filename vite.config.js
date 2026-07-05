import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import ytProxy from './server/ytproxy.js'
import apiProxy from './server/apiproxy.js'

export default defineConfig({
  plugins: [react(), ytProxy(), apiProxy()],
})
