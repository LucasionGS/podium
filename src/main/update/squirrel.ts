import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { app, autoUpdater } from 'electron'
import { SQUIRREL_FEED } from '@core/update/update'

/**
 * Squirrel.Windows installs each version into its own `app-<version>` folder next to `Update.exe`, so
 * anything that outlives a version (shortcuts, autostart, a hotkey command) must start Podium through
 * `Update.exe --processStart`, which always picks the newest one.
 */

export const squirrelUpdateExe = (): string => resolve(dirname(process.execPath), '..', 'Update.exe')

export const isSquirrelInstall = (): boolean =>
  process.platform === 'win32' && app.isPackaged && existsSync(squirrelUpdateExe())

/** `Update.exe --processStart Podium.exe [--process-start-args "<args>"]`, as a program and arguments. */
export function squirrelLaunch(args: string[]): { path: string; args: string[] } {
  const start = ['--processStart', basename(process.execPath)]
  return {
    path: squirrelUpdateExe(),
    args: args.length ? [...start, '--process-start-args', args.join(' ')] : start
  }
}

function runUpdateExe(args: string[]): void {
  spawn(squirrelUpdateExe(), args, { detached: true, stdio: 'ignore' }).unref()
}

/**
 * Squirrel runs the new version with `--squirrel-install`, `--squirrel-updated`, `--squirrel-uninstall` or
 * `--squirrel-obsolete` and expects it to do its housekeeping and exit quickly. Returns true when this
 * launch was one of those, and the app is quitting.
 */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false
  const event = process.argv.find((arg) => arg.startsWith('--squirrel-'))
  if (!event || event === '--squirrel-firstrun') return false
  const exe = basename(process.execPath)
  const quitSoon = (): void => void setTimeout(() => app.quit(), 1000)
  switch (event) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdateExe([`--createShortcut=${exe}`])
      quitSoon()
      return true
    case '--squirrel-uninstall':
      runUpdateExe([`--removeShortcut=${exe}`])
      // The login item points at Update.exe, which is about to be deleted.
      app.setLoginItemSettings({ openAtLogin: false, ...squirrelLaunch(['--hidden']) })
      quitSoon()
      return true
    default:
      app.quit()
      return true
  }
}

/**
 * Downloads the newest release through Squirrel (it reads RELEASES and the .nupkg from the feed) and
 * resolves once it's staged; `autoUpdater.quitAndInstall()` then restarts into it.
 */
export function downloadSquirrelUpdate(
  feed = process.env['PODIUM_SQUIRREL_FEED'] ?? SQUIRREL_FEED
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = (): void => {
      autoUpdater.removeListener('update-downloaded', onDownloaded)
      autoUpdater.removeListener('update-not-available', onNothing)
      autoUpdater.removeListener('error', onError)
    }
    const onDownloaded = (): void => {
      cleanup()
      resolvePromise()
    }
    const onNothing = (): void => {
      cleanup()
      reject(new Error('Squirrel found no newer version on the release feed. Try again in a few minutes.'))
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new Error(`The update couldn’t be downloaded: ${error.message}`))
    }
    autoUpdater.on('update-downloaded', onDownloaded)
    autoUpdater.on('update-not-available', onNothing)
    autoUpdater.on('error', onError)
    autoUpdater.setFeedURL({ url: feed })
    autoUpdater.checkForUpdates()
  })
}
