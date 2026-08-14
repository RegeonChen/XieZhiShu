/**
 * clipboard.ts —— 复制纯文本到系统剪贴板（渲染进程）。
 * navigator.clipboard 优先（Electron 中可用），失败回退 textarea + execCommand。
 */
export async function copyPlainText(text: string): Promise<boolean> {
  const plain = (text ?? '').trim()
  if (!plain) return false
  try {
    await navigator.clipboard.writeText(plain)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = plain
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}
