import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // host: true → escucha en 0.0.0.0 para que la oficina entre por la IP de la
    // LAN (http://{ip}:5173). El backend y el motor siguen atados a localhost:
    // todo pasa por este proxy, así solo el 5173 queda abierto en la red.
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Documentos del NAS servidos por el backend. Se proxean para que las URLs
      // guardadas puedan ser relativas (/docs/…) y funcionen desde cualquier PC.
      '/docs': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
