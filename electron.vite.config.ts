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
    },
    build: {
      /*
       * 2026-11-11（实测缺陷）：渲染层产物带内容哈希，而 `out/` 在 Vite 项目根之外 →
       * Vite 默认**不清空** outDir，每次构建新增一份、旧的永远留着。
       * 实测累积到 214 个文件 / 610 MB，且被 electron-builder 整个打进 asar（安装包虚胖约 1/3）。
       * 这里显式清空：每次构建只保留本次产物。
       */
      emptyOutDir: true
    }
  }
})
