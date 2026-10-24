import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, autoUpdater, BrowserWindow, ipcMain } from 'electron'
import { UPDATE_IPC, type AppSettings, type UpdateStatus } from '@shared/ipc'
import {
  CHECK_INTERVAL_MS,
  compareVersions,
  describeInstall,
  detectInstall,
  LATEST_RELEASE_API,
  parseRelease,
  type Install,
  type Release
} from '@core/update/update'
import {
  installAppImage,
  installAurPackage,
  installSystemPackage,
  pkexec,
  type InstallContext
} from './installers'
import { downloadSquirrelUpdate, isSquirrelInstall } from './squirrel'

/** Added to the relaunched Podium's arguments, so it waits for this one to let go of the single-instance lock. */
export const AFTER_UPDATE_ARG = '--after-update'

export interface UpdaterHooks {
  /** A system notification; the click opens Podium on the update. */
  notify(title: string, body: string): void
  /** Quits Podium the normal way (stopping the capture engine first). */
  quit(): void
}

function readPackageType(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8')
  } catch {
    return null
  }
}

/** How this copy was installed. `PODIUM_INSTALL_KIND` (`appimage`, `deb`, `pacman`, `aur:<pkg>`) overrides it for testing. */
function currentInstall(): Install {
  const override = process.env['PODIUM_INSTALL_KIND']
  if (override) {
    return detectInstall({
      platform: 'linux',
      packaged: true,
      appImage: override === 'appimage' ? (process.env['APPIMAGE'] ?? null) : null,
      packageType: override,
      squirrel: false
    })
  }
  return detectInstall({
    platform: process.platform,
    packaged: app.isPackaged,
    appImage: process.env['APPIMAGE'] ?? null,
    packageType: process.platform === 'linux' ? readPackageType() : null,
    squirrel: isSquirrelInstall()
  })
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class Updater {
  private readonly install = currentInstall()
  private status: UpdateStatus
  private release: Release | null = null
  private timer: NodeJS.Timeout | null = null
  private notified: string | null = null
  private readonly listeners = new Set<(status: UpdateStatus) => void>()

  constructor(private readonly hooks: UpdaterHooks) {
    this.status = {
      current: app.getVersion(),
      kind: this.install.kind,
      ...describeInstall(this.install),
      state: 'idle',
      available: null,
      progress: null,
      message: null,
      checkedAt: null
    }
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  onChange(listener: (status: UpdateStatus) => void): void {
    this.listeners.add(listener)
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(UPDATE_IPC.changed, this.status)
    for (const listener of this.listeners) listener(this.status)
  }

  private get busy(): boolean {
    return ['checking', 'downloading', 'installing', 'ready'].includes(this.status.state)
  }

  /** Looks for a newer release. Automatic checks announce what they find with a notification, once per version. */
  async check(manual = true): Promise<UpdateStatus> {
    if (this.busy) return this.status
    this.set({ state: 'checking', message: null })
    try {
      const res = await fetch(process.env['PODIUM_UPDATE_URL'] ?? LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Podium/${this.status.current}` },
        signal: AbortSignal.timeout(20_000)
      })
      // No release yet.
      if (res.status === 404) {
        this.set({ state: 'up-to-date', available: null, checkedAt: Date.now() })
        return this.status
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}.`)
      const release = parseRelease(await res.json())
      const newer = compareVersions(release.version, this.status.current) > 0
      this.release = newer ? release : null
      this.set({
        state: newer ? 'available' : 'up-to-date',
        available: newer
          ? {
              version: release.version,
              url: release.url,
              notes: release.notes,
              publishedAt: release.publishedAt
            }
          : null,
        checkedAt: Date.now(),
        progress: null
      })
      if (newer && !manual && this.notified !== release.version) {
        this.notified = release.version
        this.hooks.notify(
          `Podium ${release.version} is available`,
          this.status.canInstall ? 'Open Settings to install it.' : this.status.method
        )
      }
    } catch (error) {
      this.set({
        state: 'error',
        message: `Couldn’t check for updates: ${errorText(error)}`,
        checkedAt: Date.now()
      })
    }
    return this.status
  }

  /** Downloads and installs the available update; afterwards Podium waits for a restart. */
  async installUpdate(): Promise<void> {
    const release = this.release
    if (
      !release ||
      !this.status.canInstall ||
      ['downloading', 'installing', 'ready'].includes(this.status.state)
    )
      return
    this.set({ state: 'downloading', progress: null, message: null })
    const ctx: InstallContext = {
      release,
      workDir: join(app.getPath('userData'), 'updates'),
      elevate: pkexec,
      onProgress: (progress, message) => {
        // Downloads report a percentage (or say so); building and installing don't.
        const downloading = progress !== null || Boolean(message?.startsWith('Downloading'))
        this.set({ state: downloading ? 'downloading' : 'installing', progress, message })
      }
    }
    try {
      switch (this.install.kind) {
        case 'squirrel':
          this.set({ message: 'Downloading the update…' })
          await downloadSquirrelUpdate()
          break
        case 'appimage':
          await installAppImage(ctx, process.env['APPIMAGE']!)
          break
        case 'deb':
        case 'pacman':
          await installSystemPackage(ctx, this.install.kind)
          break
        case 'aur':
          await installAurPackage(ctx, this.install.aurPackage!, process.env['PODIUM_AUR_SNAPSHOT'])
          break
        default:
          throw new Error(this.status.method)
      }
      this.set({ state: 'ready', progress: 1, message: null })
    } catch (error) {
      console.warn('[update] install failed:', error)
      this.set({ state: 'error', progress: null, message: errorText(error) })
    }
  }

  /** Restarts into the installed update. */
  restart(): void {
    if (this.status.state !== 'ready') return
    if (this.install.kind === 'squirrel') {
      // Squirrel's Update.exe waits for Podium to exit, swaps the version in and starts it.
      autoUpdater.quitAndInstall()
      return
    }
    // The window was open when the user clicked restart, so the new Podium shows it again.
    const args = [
      ...process.argv.slice(1).filter((a) => a !== '--hidden' && a !== AFTER_UPDATE_ARG),
      AFTER_UPDATE_ARG
    ]
    app.relaunch(this.install.kind === 'appimage' ? { execPath: process.env['APPIMAGE'], args } : { args })
    this.hooks.quit()
  }

  /** Starts or stops the background checks to match the settings. */
  apply(settings: AppSettings): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!settings.updates.check || this.install.kind === 'dev') return
    setTimeout(() => void this.check(false), 15_000).unref()
    this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  registerIpc(): void {
    ipcMain.handle(UPDATE_IPC.status, () => this.status)
    ipcMain.handle(UPDATE_IPC.check, () => this.check(true))
    ipcMain.handle(UPDATE_IPC.install, () => this.installUpdate())
    ipcMain.on(UPDATE_IPC.restart, () => this.restart())
  }
}
