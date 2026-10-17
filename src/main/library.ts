import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, basename } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { MediaFile } from '@shared/model'
import { SUPPORTED_EXTENSIONS } from '@shared/presets'

const MAX_FILES = 5000

export async function scanFolder(folder: string): Promise<MediaFile[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  const files: MediaFile[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = extname(e.name).slice(1).toLowerCase()
    const kind = SUPPORTED_EXTENSIONS[ext]
    if (!kind) continue
    const path = join(e.parentPath, e.name)
    files.push({ path, name: e.name, rel: relative(folder, path), ext, kind, size: 0, mtime: 0 })
    if (files.length >= MAX_FILES) break
  }
  await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(f.path)
        f.size = s.size
        f.mtime = Math.round(s.mtimeMs)
      } catch {
        /* vanished between readdir and stat */
      }
    }),
  )
  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }))
  return files
}

let watcher: FSWatcher | null = null
let debounce: NodeJS.Timeout | null = null

/** Watches one library folder; rescans (debounced) when supported files change. */
export function watchFolder(folder: string, onChange: (files: MediaFile[]) => void): void {
  void watcher?.close()
  watcher = watch(folder, {
    ignoreInitial: true,
    depth: 8,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    ignored: (p, s) => !!s?.isFile() && !SUPPORTED_EXTENSIONS[extname(p).slice(1).toLowerCase()],
  })
  watcher.on('all', (_event, path) => {
    if (basename(path).startsWith('~')) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => onChange(await scanFolder(folder)), 250)
  })
}
