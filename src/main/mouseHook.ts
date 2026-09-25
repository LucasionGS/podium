import type { UiohookMouseEvent } from 'uiohook-napi'
import { acceleratorFromMouse, HOOK_MOUSE_BUTTONS } from '@core/hotkeys'

type Hook = (typeof import('uiohook-napi'))['uIOhook']

/**
 * Mouse-button hotkeys on Windows and X11, where Electron's globalShortcut only takes keys: a global input
 * hook (libuiohook) that watches button presses. It never blocks them, so the click still reaches the game.
 * Runs only while a mouse button is bound.
 */
export class MouseHook {
  private hook: Hook | null = null
  private running = false

  constructor(private readonly onPress: (accelerator: string) => void) {}

  /** Wayland (outside Hyprland, which binds mouse buttons itself) doesn't let apps watch global input. */
  static supported(): boolean {
    return process.platform === 'win32' || (process.platform === 'linux' && !process.env['WAYLAND_DISPLAY'])
  }

  /** Starts watching; returns why it can't, or null. */
  async start(): Promise<string | null> {
    if (this.running) return null
    try {
      if (!this.hook) {
        // Loaded on first use: it's a native module, and most setups never bind a mouse button.
        const { uIOhook } = await import('uiohook-napi')
        uIOhook.on('mousedown', (e: UiohookMouseEvent) => {
          const accelerator = acceleratorFromMouse({ ...e, button: Number(e.button) }, HOOK_MOUSE_BUTTONS)
          if (accelerator) this.onPress(accelerator)
        })
        this.hook = uIOhook
      }
      this.hook.start()
      this.running = true
      return null
    } catch (error) {
      console.warn('[hotkeys] mouse hook:', error)
      return 'Podium can’t watch mouse buttons on this system'
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    try {
      this.hook?.stop()
    } catch (error) {
      console.warn('[hotkeys] mouse hook:', error)
    }
  }
}
