// onnxruntime-node stub：转发到 onnxruntime-web（WASM 后端）。
// 原因：本机 C:\Windows\System32\onnxruntime.dll（Windows 系统组件）优先于应用目录被加载，
// 导致 onnxruntime-node 原生绑定版本不匹配（DLL 初始化失败）。WASM 后端无原生 DLL 依赖。
'use strict'
module.exports = require('onnxruntime-web')
