import { app, globalShortcut, ipcMain } from 'electron'
import { HOTKEYS_IPC, type ClipAction, type Hotkey, type HotkeyStatus } from '@shared/ipc'
import { acceleratorKey, actionToArgs, isMouseAccelerator, planShortcuts } from '@core/hotkeys'
import { HyprlandBinds, isHyprland } from './hyprland'
import { MouseHook } from './mouseHook'

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
  /** Accelerators registered with the OS (or the mouse hook) right now; not used on Hyprland. */
  private readonly registered = new Set<string>()
  private readonly mouse = new MouseHook((accelerator) => this.press(accelerator))
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
      const plan = planShortcuts(this.registered, list)
      const failed = plan.duplicates.map((id) => ({
        id,
        reason: 'Another Podium hotkey already uses this key'
      }))
      if (this.hyprland) {
        const unique = list.filter((h) => !plan.duplicates.includes(h.id))
        this.failed = [...failed, ...(await this.hyprland.apply(unique))]
        return
      }
      // Only the keys that changed: Windows can refuse a key Podium released a moment ago.
      for (const accelerator of plan.unregister) {
        if (!isMouseAccelerator(accelerator)) globalShortcut.unregister(accelerator)
        this.registered.delete(accelerator)
      }
      if (![...this.registered].some(isMouseAccelerator)) this.mouse.stop()
      for (const accelerator of plan.register) {
        const reason = await this.registerKey(accelerator)
        if (!reason) continue
        console.warn(`[hotkeys] ${accelerator}: ${reason}`)
        for (const hotkey of list)
          if (hotkey.accelerator && acceleratorKey(hotkey.accelerator) === acceleratorKey(accelerator))
            failed.push({ id: hotkey.id, reason })
      }
      this.failed = failed
    })
    return this.applying.catch((error) => console.error('[hotkeys]', error))
  }

  /** A registered key or button was pressed. Looked up now, so changing what a key does needs no re-registering. */
  private press(accelerator: string): void {
    if (this.suspended) return
    const hotkey = this.hotkeys.find(
      (h) => h.accelerator && acceleratorKey(h.accelerator) === acceleratorKey(accelerator)
    )
    if (hotkey) this.fire(hotkey.action)
  }

  /** Registers one key (with the OS) or mouse button (with the hook); returns why it failed, or null. */
  private async registerKey(accelerator: string): Promise<string | null> {
    if (isMouseAccelerator(accelerator)) {
      if (!MouseHook.supported()) return 'Mouse buttons can’t be hotkeys on this desktop'
      const reason = await this.mouse.start()
      if (!reason) this.registered.add(accelerator)
      return reason
    }
    try {
      const ok = globalShortcut.register(accelerator, () => this.press(accelerator))
      if (ok) {
        this.registered.add(accelerator)
        return null
      }
    } catch {
      return "Podium can't use this key combination"
    }
    return process.platform === 'win32'
      ? 'Another app is already using this key (often the NVIDIA, AMD or Xbox Game Bar overlay)'
      : 'Another app is already using this key'
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
    this.mouse.stop()
    this.registered.clear()
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
