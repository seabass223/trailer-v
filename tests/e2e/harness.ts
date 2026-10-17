import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// No trailing separator: `"C:\dir\"` would escape the closing quote on Windows.
export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '')
export const FIXTURES = join(ROOT, 'fixtures')

export interface AppHandle {
  app: ElectronApplication
  page: Page
  dataDir: string
  logs: string[]
}

/** Launch the built app (out/) against an isolated temp data dir. */
export async function launch(): Promise<AppHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'trailer-v-e2e-'))
  // TRAILER_EXE=dist/win-unpacked/Trailer-V.exe runs the suite against the packaged app.
  const exe = process.env.TRAILER_EXE
  const app = await electron.launch({
    ...(exe ? { executablePath: join(ROOT, exe), args: [] } : { args: [ROOT] }),
    cwd: ROOT,
    env: { ...process.env, TRAILER_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' },
  })
  const page = await app.firstWindow()
  const logs: string[] = []
  app.process().stdout?.on('data', (d: Buffer) => logs.push(`[main] ${d.toString().trim()}`))
  app.process().stderr?.on('data', (d: Buffer) => logs.push(`[main:err] ${d.toString().trim()}`))
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.on('crash', () => logs.push('[error] RENDERER CRASHED'))
  page.on('framenavigated', (f) => f === page.mainFrame() && logs.push(`[nav] ${f.url()}`))
  await page.setViewportSize({ width: 1680, height: 1000 }).catch(() => {})
  return { app, page, dataDir, logs }
}

/** Replace native dialogs in the main process with fixed answers. */
export async function stubDialogs(app: ElectronApplication, folder: string, savePath: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, { folder, savePath }) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: savePath })) as typeof dialog.showSaveDialog
    },
    { folder, savePath },
  )
}

/** Pointer drag between two points with intermediate moves (our drags are pointer-driven). */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(50)
  await page.mouse.up()
}
