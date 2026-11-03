import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期将 /api 代理到本地 FastAPI 服务（127.0.0.1:8300），前端无需关心 CORS
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8300',
        changeOrigin: true,
      },
    },
  },
})
