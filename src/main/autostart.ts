import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

const desktopFile = (): string =>
  join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'autostart', 'podium.desktop')

/** Start with the desktop session, hidden in the tray. Linux uses XDG autostart; Windows and macOS the OS setting. */
export async function applyAutostart(enabled: boolean): Promise<void> {
  // A development build would register the bare Electron binary.
  if (!app.isPackaged) return
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    return
  }
  if (!enabled) {
    await rm(desktopFile(), { force: true })
    return
  }
  const executable = process.env['APPIMAGE'] ?? process.execPath
  await mkdir(join(desktopFile(), '..'), { recursive: true })
  await writeFile(
    desktopFile(),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Podium',
      'Comment=Instant replay buffer for clipping games',
      `Exec="${executable}" --hidden`,
      'Icon=podium',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
  )
}
