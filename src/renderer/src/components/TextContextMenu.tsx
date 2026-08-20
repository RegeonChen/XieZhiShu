import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { zhCN } from '../i18n/zh-CN'

interface MenuState {
  x: number
  y: number
  target: HTMLInputElement | HTMLTextAreaElement | HTMLElement
}

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement

/** 可弹出文本右键菜单的 input 类型（排除 checkbox/radio/button 等非文本控件） */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number'])

function isTextInput(el: HTMLElement): el is HTMLInputElement {
  return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
}

/**
 * 找到应处理右键菜单的文本可编辑目标：
 * input / textarea / contenteditable。正文编辑器（.draft-editor__doc）由 DraftEditor 自行提供菜单，这里排除避免双菜单。
 */
function resolveEditableTarget(el: Element | null): EditableTarget | null {
  if (!el || !(el instanceof HTMLElement)) return null
  if (el.closest('.draft-editor__doc')) return null
  if (isTextInput(el)) return el
  if (el.tagName === 'TEXTAREA') return el as HTMLTextAreaElement
  if (el.isContentEditable) return el
  const ce = el.closest('[contenteditable="true"]')
  return ce ? (ce as HTMLElement) : null
}

function focusTarget(target: EditableTarget): void {
  try {
    target.focus({ preventScroll: true })
  } catch {
    target.focus()
  }
}

function readSelection(target: EditableTarget): string {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? 0
    return target.value.slice(start, end)
  }
  return window.getSelection()?.toString() ?? ''
}

/** React 受控组件在程序化改值后需要用原生 setter + input 事件通知（避免 React 状态与 DOM 不同步） */
function setNativeValue(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  desc?.set?.call(target, value)
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const res = await window.api.writeClipboardText(text)
    return res.ok
  }
}

async function readClipboard(): Promise<string> {
  const res = await window.api.readClipboardText()
  return res.ok && res.data ? res.data.text : ''
}

function deleteSelection(target: EditableTarget): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? 0
    setNativeValue(target, target.value.slice(0, start) + target.value.slice(end))
    target.setSelectionRange(start, start)
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  document.execCommand('delete')
}

function selectAllTarget(target: EditableTarget): void {
  focusTarget(target)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select()
  } else {
    document.execCommand('selectAll')
  }
}

/**
 * 全局文本右键菜单（2026-08-20）：在 input/textarea/contenteditable 上右键时弹出
 * 「剪切 / 复制 / 粘贴 / 全选」。粘贴经主进程读取系统剪贴板（沙箱渲染进程不可直接访问）。
 */
function TextContextMenu(): ReactNode {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      const target = resolveEditableTarget(e.target as Element | null)
      if (!target) return
      e.preventDefault()
      const x = Math.min(e.clientX, window.innerWidth - 200)
      const y = Math.min(e.clientY, window.innerHeight - 180)
      setMenu({ x: Math.max(4, x), y: Math.max(4, y), target })
    }

    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }

    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [])

  if (!menu) return null

  const hasSelection = readSelection(menu.target).length > 0
  const t = zhCN.contextMenu

  const handleCopy = async (): Promise<void> => {
    const text = readSelection(menu.target)
    if (text) await writeClipboard(text)
    setMenu(null)
  }

  const handleCut = async (): Promise<void> => {
    const text = readSelection(menu.target)
    if (!text) return
    focusTarget(menu.target)
    await writeClipboard(text)
    deleteSelection(menu.target)
    setMenu(null)
  }

  const handlePaste = async (): Promise<void> => {
    const text = await readClipboard()
    if (!text) return
    focusTarget(menu.target)
    if (menu.target instanceof HTMLInputElement || menu.target instanceof HTMLTextAreaElement) {
      const start = menu.target.selectionStart ?? menu.target.value.length
      const end = menu.target.selectionEnd ?? start
      setNativeValue(menu.target, menu.target.value.slice(0, start) + text + menu.target.value.slice(end))
      menu.target.setSelectionRange(start + text.length, start + text.length)
      menu.target.dispatchEvent(new Event('input', { bubbles: true }))
      menu.target.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      document.execCommand('insertText', false, text)
    }
    setMenu(null)
  }

  return createPortal(
    <div className="text-context-menu__backdrop" onMouseDown={() => setMenu(null)}>
      <div className="text-context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="text-context-menu__item" disabled={!hasSelection} onClick={() => void handleCut()}>
          {t.cut}
        </button>
        <button type="button" className="text-context-menu__item" disabled={!hasSelection} onClick={() => void handleCopy()}>
          {t.copy}
        </button>
        <button type="button" className="text-context-menu__item" onClick={() => void handlePaste()}>
          {t.paste}
        </button>
        <button type="button" className="text-context-menu__item" onClick={() => { selectAllTarget(menu.target); setMenu(null) }}>
          {t.selectAll}
        </button>
      </div>
    </div>,
    document.body
  )
}

export default TextContextMenu
