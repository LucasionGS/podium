import { app, globalShortcut, ipcMain } from 'electron'
import { HOTKEYS_IPC, type ClipAction, type Hotkey, type HotkeyStatus } from '@shared/ipc'
import { actionToArgs } from '@core/hotkeys'
import { HyprlandBinds, isHyprland } from './hyprland'

const isWayland = (): boolean => process.platform === 'linux' && Boolean(process.env['WAYLAND_DISPLAY'])

/**
 * Wayland doesn't let apps grab keys globally; Chromium can ask the desktop through the
 * GlobalShortcuts portal instead (KDE, GNOME). Hyprland gets real compositor binds instead, see
 * `HyprlandBinds`. Has to be switched on before the app is ready.
 */
export function enableShortcutPortal(): void {
  if (isWayland() && !isHyprland()) app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

/** The command that makes the running Podium do something (see `actionFromArgs`). */
export function cliCommand(action: ClipAction): string {
  const quote = (s: string): string => (/[\s"'$]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s)
  const executable = process.env['APPIMAGE'] ?? process.execPath
  // In development the executable is Electron itself and needs the app folder.
  const base = app.isPackaged ? [executable] : [executable, app.getAppPath()]
  return [...base, ...actionToArgs(action)].map(quote).join(' ')
}

export class Hotkeys {
  private hotkeys: Hotkey[] = []
  private failed: HotkeyStatus['failed'] = []
  private suspended = false
  private active = false
  private readonly hyprland: HyprlandBinds | null
  private applying: Promise<void> = Promise.resolve()

  constructor(private readonly fire: (action: ClipAction) => void) {
    this.hyprland = isHyprland() ? new HyprlandBinds(fire) : null
  }

  /** `register: false` only records the list (test runs must not grab the user's keys). */
  apply(hotkeys: Hotkey[], register = true): Promise<void> {
    this.hotkeys = hotkeys
    if (!register) return this.applying
    if (!this.active && this.hyprland) this.hyprland.start()
    this.active = true
    return this.register()
  }

  private register(): Promise<void> {
    // Serialised: a quick series of changes must not interleave bind and unbind calls.
    this.applying = this.applying.then(async () => {
      const list = this.suspended ? [] : this.hotkeys
      if (this.hyprland) {
        this.failed = await this.hyprland.apply(list)
        return
      }
      globalShortcut.unregisterAll()
      this.failed = []
      for (const hotkey of list) {
        if (!hotkey.accelerator) continue
        let ok = false
        try {
          ok = globalShortcut.register(hotkey.accelerator, () => this.fire(hotkey.action))
        } catch {
          ok = false
        }
        if (!ok) this.failed.push({ id: hotkey.id, reason: 'Another app is already using this key' })
      }
    })
    return this.applying.catch((error) => console.error('[hotkeys]', error))
  }

  /** While a new binding is being recorded, the old ones must not fire (or, on Hyprland, swallow the keys). */
  suspend(suspended: boolean): void {
    if (this.suspended === suspended || !this.active) return
    this.suspended = suspended
    void this.register()
  }

  stop(): void {
    this.hyprland?.stop()
    if (this.active && !this.hyprland) globalShortcut.unregisterAll()
    this.active = false
  }

  async status(): Promise<HotkeyStatus> {
    await this.applying
    return {
      mechanism: this.hyprland ? 'hyprland' : isWayland() ? 'portal' : 'global',
      failed: this.failed,
      cliCommand: cliCommand({ kind: 'clip', seconds: 30 })
    }
  }

  registerIpc(): void {
    ipcMain.handle(HOTKEYS_IPC.status, () => this.status())
    ipcMain.on(HOTKEYS_IPC.suspend, (_e, suspended: boolean) => this.suspend(suspended))
  }
}
