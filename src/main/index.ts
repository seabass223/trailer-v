import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CreateProjectInput } from '@shared/ipc'
import type { Project } from '@shared/model'
import { encoderCaps } from './encoder'
import { registerExportIpc } from './export-window'
import { listFonts } from './fonts'
import { scanFolder, watchFolder } from './library'
import {
  createProject, duplicateProject, listProjects, readProject, removeProject, renameProject, saveProject, savePoster,
} from './projects'
import { startMcpServer, stopMcpServer } from './mcp/server'
import { handleProtocols, registerSchemes } from './protocols'
import { shellCopy } from './shell-copy'
import { registerGenerateIpc } from './yue2'

// --- GPU / scheduling: this app lives on the RTX, never throttle it. ---
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
// The export window is hidden; don't let Chromium deprioritise its GPU/decoder work.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

if (process.env.TRAILER_DATA_DIR) app.setPath('userData', join(process.env.TRAILER_DATA_DIR, 'userData'))

registerSchemes()
// Must match build.appId so Start menu / taskbar pins group with the running window and show its icon.
app.setAppUserModelId('dev.trailerv.editor')

const dirname = import.meta.dirname
let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Trailer-V',
    // Packaged builds take the icon from the .exe; dev runs need it passed explicitly.
    ...(app.isPackaged ? {} : { icon: join(dirname, '../../build/icon.ico') }),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1115', symbolColor: '#c3c8d1', height: 52 },
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // A file dropped outside a drop zone must not navigate the editor away to that file.
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged) {
    // Surface renderer + worker logs in the terminal during development.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning' || e.message.startsWith('[')) {
        console.log(`[renderer:${e.level}] ${e.message}`)
      }
    })
  }
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadURL('app://bundle/index.html')
  }
}

async function directory(path: string): Promise<string> {
  const abs = resolve(path)
  if (!(await stat(abs).catch(() => null))?.isDirectory()) throw new Error(`Folder not found: ${abs}`)
  return abs
}

function registerIpc(): void {
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', (_e, input: CreateProjectInput) => createProject(input))
  ipcMain.handle('projects:read', (_e, id: string) => readProject(id))
  ipcMain.handle('projects:save', (_e, p: Project) => saveProject(p))
  ipcMain.handle('projects:rename', (_e, id: string, name: string) => renameProject(id, name))
  ipcMain.handle('projects:duplicate', (_e, id: string) => duplicateProject(id))
  ipcMain.handle('projects:remove', (_e, id: string) => removeProject(id))
  ipcMain.handle('projects:savePoster', (_e, id: string, jpeg: Uint8Array) => savePoster(id, jpeg))

  ipcMain.handle('library:scan', async (e, folder: string) => {
    const files = await scanFolder(folder)
    watchFolder(folder, (next) => {
      if (!e.sender.isDestroyed()) e.sender.send('library:changed', folder, next)
    })
    return files
  })
  ipcMain.handle('library:copyIn', async (e, sources: string[], folder: string) => {
    const dir = await directory(folder)
    const files = (await Promise.all(sources.map(async (p) => ((await stat(p).catch(() => null))?.isFile() ? resolve(p) : null))))
      .filter((p): p is string => !!p)
    return shellCopy(files, dir, BrowserWindow.fromWebContents(e.sender))
  })
  ipcMain.handle('library:openFolder', async (_e, folder: string) => {
    const err = await shell.openPath(await directory(folder))
    if (err) throw new Error(err)
  })
  ipcMain.handle('library:readText', async (_e, path: string) => {
    if (!path.toLowerCase().endsWith('.txt')) throw new Error('Not a text file')
    return (await readFile(path, 'utf8')).slice(0, 20_000)
  })

  ipcMain.handle('dialog:pickFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:saveVideo', async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath('videos'), defaultName),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('fonts:list', () => listFonts())
  ipcMain.handle('encoder:caps', () => encoderCaps())
  ipcMain.handle('shell:showItem', (_e, path: string) => shell.showItemInFolder(path))

  registerExportIpc()
  registerGenerateIpc()
}

app.whenReady().then(() => {
  handleProtocols(join(dirname, '../renderer'))
  registerIpc()
  createWindow()
  // Local MCP endpoint for agents (src/main/mcp/server.ts).
  startMcpServer(() => win)
  // Warm caches off the critical path.
  void encoderCaps()
  void listFonts()
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => stopMcpServer())
