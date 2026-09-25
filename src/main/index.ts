import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, session, shell } from 'electron'
import {
  CAPTURE_IPC,
  GAMES_IPC,
  IPC,
  SETTINGS_IPC,
  type AppInfo,
  type AppSettings,
  type ClipAction,
  type ClipView
} from '@shared/ipc'
import { actionFromArgs } from '@core/hotkeys'
import { formatDuration, formatLength } from '@core/library/naming'
import { applyAutostart } from './autostart'
import { CaptureManager } from './capture/manager'
import { cancelAllExports, registerExportIpc } from './export'
import { resolveFfmpeg } from './ffmpeg/paths'
import { GameDetector } from './games/detect'
import { enableShortcutPortal, Hotkeys } from './hotkeys'
import { reconcileLibrary, registerFileProtocolScheme, registerLibraryIpc, thumbnailFor } from './library'
import { libraryDir } from './paths'
import { getSettings, onSettingsChanged, updateSettings } from './settings'
import { PodiumTray } from './tray'
import { loadRendererPage } from './windows'

// ---------------------------------------------------------------- Test and automation hooks

/** Screenshot runs never show a window, never touch the user's profile and stay silent. */
const isAutomatedRun = Boolean(process.env['PODIUM_SCREENSHOT'] || process.env['PODIUM_HEADLESS'])
if (isAutomatedRun) {
  // Chromium's helper processes can outlive us and re-create files, so exit-time cleanup is best effort;
  // sweep profiles left behind by earlier runs (old enough not to belong to a run in progress).
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('podium-test-profile-')) continue
    const stale = join(tmpdir(), name)
    if (Date.now() - statSync(stale).mtimeMs > 10 * 60_000) rmSync(stale, { recursive: true, force: true })
  }
  if (!process.env['PODIUM_USER_DATA']) {
    const profile = mkdtempSync(join(tmpdir(), 'podium-test-profile-'))
    app.setPath('userData', profile)
    // `app.exit()` skips Electron's quit events, so clean up on the process itself.
    process.on('exit', () => rmSync(profile, { recursive: true, force: true }))
  }
  app.commandLine.appendSwitch('mute-audio')
}
// `PODIUM_USER_DATA=<dir>` runs against a given profile (e.g. a copy of a user's, to reproduce a bug).
if (process.env['PODIUM_USER_DATA']) app.setPath('userData', process.env['PODIUM_USER_DATA'])

/** `PODIUM_SCREENSHOT=<png>` saves a screenshot after load (optionally after `PODIUM_DEBUG_SCRIPT` ran) and quits. */
function captureForDebug(win: BrowserWindow): void {
  const target = process.env['PODIUM_SCREENSHOT']
  if (!target) return
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message))
  win.webContents.once('did-finish-load', () => {
    setTimeout(
      async () => {
        const script = process.env['PODIUM_DEBUG_SCRIPT']
        if (script) {
          await win.webContents.executeJavaScript(readFileSync(script, 'utf8')).then(
            (result) => console.log('[script]', typeof result === 'string' ? result : JSON.stringify(result)),
            (error) => console.log('[script error]', error)
          )
        }
        await win.webContents
          .capturePage()
          .then((image) => writeFile(target, image.toPNG()))
          .finally(() => app.exit(0))
      },
      Number(process.env['PODIUM_SCREENSHOT_DELAY'] ?? 2500)
    )
  })
}

// ---------------------------------------------------------------- App state

const games = new GameDetector(() => currentSettings?.gameRules ?? [])
const capture = new CaptureManager(games)
const hotkeys = new Hotkeys((action) => void saveClip(action))
const tray = new PodiumTray({
  save: (action) => void saveClip(action),
  toggleBuffer: () => {
    const state = capture.getStatus().state
    void (state === 'buffering' || state === 'starting' ? capture.stop() : capture.start())
  },
  show: () => showWindow(),
  quit: () => quit()
})
let mainWindow: BrowserWindow | null = null
let currentSettings: AppSettings | null = null
let quitting = false

const startHidden = process.argv.includes('--hidden')

function createMainWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Podium',
    backgroundColor: '#0e0f11',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      // The hidden window still plays the "clip saved" sound and keeps the library up to date.
      backgroundThrottling: false,
      offscreen: Boolean(process.env['PODIUM_SCREENSHOT'])
    }
  })
  if (show && !isAutomatedRun) win.once('ready-to-show', () => win.show())
  // With the tray, closing only hides the window: the replay buffer keeps running.
  win.on('close', (event) => {
    if (quitting || isAutomatedRun || !currentSettings?.closeToTray || !tray.exists) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // Closing wasn't turned into hiding (no tray, or the setting is off): quit. Hidden helper
    // windows (the Windows audio capture page) must not keep Podium running without a UI.
    if (!quitting) quit()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRendererPage(win, 'index')
  captureForDebug(win)
  return win
}

function showWindow(route?: string): void {
  if (!mainWindow) mainWindow = createMainWindow(true)
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  if (route) {
    const win = mainWindow
    const send = (): void => win.webContents.send(IPC.navigate, route)
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }
}

function quit(): void {
  quitting = true
  app.quit()
}

// ---------------------------------------------------------------- Saving clips (hotkeys, tray, CLI)

const describeAction = (action: ClipAction): string =>
  action.kind === 'clip' ? `Last ${formatLength(action.seconds)}` : 'Whole buffer (bookmark)'

async function saveClip(action: ClipAction): Promise<ClipView | null> {
  try {
    const clip = await capture.save(action)
    if (!clip) {
      notify('Replay buffer is off', 'Start the replay buffer in Podium to save clips.')
      return null
    }
    return clip
  } catch (error) {
    notify('Could not save the clip', error instanceof Error ? error.message : String(error))
    return null
  }
}

function notify(title: string, body: string, icon?: string, onClick?: () => void): void {
  if (isAutomatedRun || !currentSettings?.notifications.system || !Notification.isSupported()) return
  const notification = new Notification({ title, body, icon, silent: true })
  if (onClick) notification.on('click', onClick)
  notification.show()
}

async function announceSaved(clip: ClipView, action: ClipAction): Promise<void> {
  const settings = currentSettings
  if (!settings) return
  if (settings.notifications.sound) mainWindow?.webContents.send(IPC.playCue)
  if (!settings.notifications.system) return
  const thumbnail = await thumbnailFor(clip).catch(() => null)
  notify(
    `Clip saved · ${clip.gameName ?? 'Desktop'}`,
    `${describeAction(action)} · ${formatDuration(clip.duration)}`,
    thumbnail ?? undefined,
    () => showWindow(`clip/${clip.id}`)
  )
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle(IPC.ffmpegInfo, () => resolveFfmpeg())
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    platform: process.platform,
    sessionType: process.env['XDG_SESSION_TYPE'] ?? null,
    desktop: process.env['XDG_CURRENT_DESKTOP'] ?? null,
    userData: app.getPath('userData'),
    libraryDir: await libraryDir()
  }))
  ipcMain.handle(IPC.dialogChooseFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.dialogSaveFile, async (e, defaultName: string, extensions: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showSaveDialog(win, {
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Output', extensions }]
    })
    return res.canceled ? null : (res.filePath ?? null)
  })
  ipcMain.on(IPC.copyText, (_e, text: string) => {
    // Automated runs must not overwrite whatever the user has on their clipboard.
    if (isAutomatedRun) console.log('[clipboard]', text)
    else clipboard.writeText(text)
  })
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle(SETTINGS_IPC.get, () => getSettings())
  ipcMain.handle(SETTINGS_IPC.update, (_e, patch: Partial<AppSettings>) => updateSettings(patch))

  ipcMain.handle(CAPTURE_IPC.capabilities, (_e, refresh?: boolean) => capture.getCapabilities(refresh))
  ipcMain.handle(CAPTURE_IPC.status, () => capture.getStatus())
  ipcMain.handle(CAPTURE_IPC.start, () => capture.start())
  ipcMain.handle(CAPTURE_IPC.stop, () => capture.stop())
  ipcMain.handle(CAPTURE_IPC.restart, () => capture.restart())
  ipcMain.handle(CAPTURE_IPC.save, (_e, action: ClipAction) => saveClip(action))
  ipcMain.handle(CAPTURE_IPC.preview, (_e, monitor: string) => capture.preview(String(monitor)))

  ipcMain.handle(GAMES_IPC.current, () => games.game)
  games.onChange((game) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(GAMES_IPC.changed, game)
  })

  hotkeys.registerIpc()
  registerLibraryIpc()
  registerExportIpc()
}

// ---------------------------------------------------------------- Startup

enableShortcutPortal()
// Windows only shows notifications for apps with an identity (it matches electron-builder's appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.ionnet.podium')
registerFileProtocolScheme()

// Chromium reorders switches in the argv it forwards, so the original is sent along as well.
if (!isAutomatedRun && !app.requestSingleInstanceLock({ argv: process.argv })) {
  // Podium is already running: it receives our argv (e.g. `--clip 30`) through 'second-instance'.
  app.quit()
} else {
  app.on('second-instance', (_e, chromiumArgv, _cwd, data) => {
    const argv = (data as { argv?: string[] } | null)?.argv ?? chromiumArgv
    const action = actionFromArgs(argv)
    if (action) void saveClip(action)
    else if (!argv.includes('--hidden')) showWindow()
  })

  void app.whenReady().then(async () => {
    currentSettings = await getSettings()
    // Nothing on the web needs device or notification access; the app talks to the OS itself.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    registerIpc()

    capture.onSaved((clip, action) => void announceSaved(clip, action))
    capture.onStatus((status) => tray.update(status))
    onSettingsChanged((next, previous) => {
      currentSettings = next
      void capture.applySettings(next, previous)
      if (JSON.stringify(next.hotkeys) !== JSON.stringify(previous.hotkeys))
        hotkeys.apply(next.hotkeys, !isAutomatedRun)
      if (next.startup.autostart !== previous.startup.autostart) void applyAutostart(next.startup.autostart)
    })

    mainWindow = createMainWindow(!(startHidden && currentSettings.startup.startHidden))
    // Each piece starts on its own: a failing tray or hotkey must never keep the window or the buffer from starting.
    const step = (name: string, run: () => unknown): void => {
      try {
        const result = run()
        if (result instanceof Promise)
          result.catch((error) => console.error(`[startup] ${name} failed:`, error))
      } catch (error) {
        console.error(`[startup] ${name} failed:`, error)
      }
    }
    if (!isAutomatedRun) step('tray', () => tray.create(capture.getStatus()))
    step('hotkeys', () => hotkeys.apply(currentSettings!.hotkeys, !isAutomatedRun))
    step('games', () => games.start())
    step('library', () => reconcileLibrary(true))
    // Test runs only capture with the fake engine, unless PODIUM_REAL_CAPTURE asks for the real one.
    const mayCapture =
      !isAutomatedRun || process.env['PODIUM_BACKEND'] === 'fake' || process.env['PODIUM_REAL_CAPTURE']
    if (currentSettings.bufferOnLaunch && mayCapture) step('capture', () => capture.start())
  })

  app.on('before-quit', () => {
    quitting = true
    cancelAllExports()
  })
  // Stop the engine before exiting, so gpu-screen-recorder never outlives Podium, but never let that hang the quit.
  let stopped = false
  app.on('will-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    stopped = true
    games.stop()
    hotkeys.stop()
    const deadline = new Promise((resolve) => setTimeout(resolve, 4000))
    void Promise.race([capture.shutdown(), deadline]).finally(() => app.exit(0))
  })
  app.on('window-all-closed', () => {
    // Keep running in the tray; without one (e.g. a desktop without a tray), closing means quitting.
    if (!tray.exists || quitting) app.quit()
  })
}
