// Renders build/icon.svg into build/icon.png (1024px) and a multi-size build/icon.ico.
// electron-builder picks both up automatically from build/. Run with: npm run icon
import { app, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const buildDir = join(import.meta.dirname, '..', 'build')
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

function packIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1)
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bpp
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...pngs.map((p) => p.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = await readFile(join(buildDir, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const render = async (size) => {
    const url = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
      await img.decode()
      const c = document.createElement('canvas')
      c.width = c.height = ${size}
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
      return c.toDataURL('image/png')
    })()`)
    return Buffer.from(url.split(',')[1], 'base64')
  }
  await writeFile(join(buildDir, 'icon.png'), await render(1024))
  const pngs = []
  for (const size of icoSizes) pngs.push({ size, data: await render(size) })
  await writeFile(join(buildDir, 'icon.ico'), packIco(pngs))
  console.log('Wrote build/icon.png and build/icon.ico')
  app.quit()
})
