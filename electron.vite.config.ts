import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 主进程多入口：index.js（主 bundle）+ embed.worker.js（向量嵌入 Worker 线程，
        // 供 src/main/rag/embed.ts 通过 worker_threads 加载，把 WASM 推理移出主进程事件循环）
        input: {
          index: resolve('src/main/index.ts'),
          'embed.worker': resolve('src/main/rag/embed.worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    }
  }
})
