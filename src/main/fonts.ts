import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const cacheFile = () => join(app.getPath('userData'), 'fonts.json')

const SCRIPT =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
  'Add-Type -AssemblyName System.Drawing;' +
  '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'

function enumerate(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve([])
        const names = [...new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
        resolve(names.sort((a, b) => a.localeCompare(b)))
      },
    )
  })
}

let pending: Promise<string[]> | null = null

/** Installed font families. Served from cache instantly; refreshed in the background. */
export async function listFonts(): Promise<string[]> {
  if (pending) return pending
  pending = (async () => {
    try {
      const cached = JSON.parse(await readFile(cacheFile(), 'utf8')) as string[]
      void enumerate().then((fresh) => {
        if (fresh.length) void writeFile(cacheFile(), JSON.stringify(fresh))
      })
      if (cached.length) return cached
    } catch {
      /* no cache yet */
    }
    const fresh = await enumerate()
    if (fresh.length) await writeFile(cacheFile(), JSON.stringify(fresh))
    return fresh
  })()
  return pending
}
