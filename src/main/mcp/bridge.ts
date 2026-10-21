/**
 * Main → editor calls for the MCP server. The editor (renderer) owns the open project and its
 * undo history, so edits run there (src/renderer/src/features/automation); this side only
 * waits for the page to be listening and matches replies to calls.
 */
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

let seq = 0
const pending = new Map<number, Pending>()
/** Per page: resolves once its automation handlers are registered. */
const ready = new WeakMap<WebContents, { promise: Promise<void>; resolve: () => void }>()

function readyFor(wc: WebContents) {
  let r = ready.get(wc)
  if (!r) {
    let resolve!: () => void
    const promise = new Promise<void>((res) => (resolve = res))
    r = { promise, resolve }
    ready.set(wc, r)
  }
  return r
}

export function registerAutomationIpc(): void {
  ipcMain.on('automation:ready', (e) => readyFor(e.sender).resolve())
  ipcMain.on('automation:reply', (_e, id: number, ok: boolean, value: unknown) => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    if (ok) p.resolve(value)
    else p.reject(new Error(String(value)))
  })
}

/** Reset readiness when the page reloads (handlers re-register on load). */
export function trackPage(win: BrowserWindow): void {
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) ready.delete(win.webContents)
  })
}

export async function callEditor<T>(win: BrowserWindow | null, method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
  if (!win || win.isDestroyed()) throw new Error('The Trailer-V window is not open')
  const wc = win.webContents
  const r = readyFor(wc)
  const ok = await Promise.race([r.promise.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 15_000))])
  if (!ok) throw new Error('The editor did not start listening (is the window still loading?)')
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The editor did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    wc.send('automation:call', id, method, params)
  })
}
