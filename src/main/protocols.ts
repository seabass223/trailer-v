import { net, protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { SUPPORTED_EXTENSIONS } from '@shared/presets'
import { projectsDir } from './projects'

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    {
      scheme: 'media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true },
    },
  ])
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', txt: 'text/plain; charset=utf-8',
  html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
  svg: 'image/svg+xml', woff2: 'font/woff2', wasm: 'application/wasm',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

function canServe(path: string): boolean {
  const ext = extname(path).slice(1).toLowerCase()
  if (SUPPORTED_EXTENSIONS[ext]) return true
  return normalize(path).toLowerCase().startsWith(projectsDir().toLowerCase())
}

/** media://local/<encoded absolute path> with HTTP Range support, streamed from disk. */
async function handleMedia(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const path = decodeURIComponent(new URL(req.url).pathname.slice(1))
  if (!canServe(path)) return new Response('Forbidden', { status: 403, headers: CORS })
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return new Response('Not found', { status: 404, headers: CORS })
  }
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  }
  const range = req.headers.get('range')
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (m) {
    let start = m[1] ? Number(m[1]) : 0
    let end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (!m[1] && m[2]) {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    const body = Readable.toWeb(createReadStream(path, { start, end, highWaterMark: 1 << 20 })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    })
  }
  const body = Readable.toWeb(createReadStream(path, { highWaterMark: 1 << 20 })) as ReadableStream
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}

/** Production renderer origin with cross-origin isolation headers (SharedArrayBuffer). */
async function handleApp(req: Request, root: string): Promise<Response> {
  const url = new URL(req.url)
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = normalize(join(root, rel))
  if (!file.startsWith(normalize(root))) return new Response('Forbidden', { status: 403 })
  const res = await net.fetch(pathToFileURL(file).toString())
  const headers = new Headers(res.headers)
  headers.set('Content-Type', MIME[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return new Response(res.body, { status: res.status, headers })
}

export function handleProtocols(rendererRoot: string): void {
  protocol.handle('media', handleMedia)
  protocol.handle('app', (req) => handleApp(req, rendererRoot))
}
