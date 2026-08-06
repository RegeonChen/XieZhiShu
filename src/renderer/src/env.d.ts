/// <reference types="vite/client" />

// pdf.js worker 构建无类型声明（仅作副作用导入，设置 globalThis.pdfjsWorker）
declare module 'pdfjs-dist/build/pdf.worker.min.mjs'
