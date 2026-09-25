import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

export function loadRendererPage(win: BrowserWindow, page: 'index', hash = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(`${devUrl}/${page}.html${hash ? `#${hash}` : ''}`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`), { hash })
  }
}
