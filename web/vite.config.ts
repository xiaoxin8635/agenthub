import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期将 /api 代理到本地 FastAPI 服务（127.0.0.1:8300），前端无需关心 CORS
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 三方库独立分包：业务代码迭代不影响框架层缓存
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
          echarts: ['echarts'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // 禁缓存：dev server 全部响应带 no-store，杜绝浏览器拿到旧模块（页面缺新功能/缺字段渲染）
    headers: { 'Cache-Control': 'no-store' },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8300',
        changeOrigin: true,
      },
    },
  },
})
