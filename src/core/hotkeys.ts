import type { ClipAction, Hotkey } from '@shared/ipc'

const MODS: Record<string, string> = {
  alt: 'ALT',
  option: 'ALT',
  altgr: 'ALT',
  shift: 'SHIFT',
  control: 'CTRL',
  ctrl: 'CTRL',
  commandorcontrol: 'CTRL',
  cmdorctrl: 'CTRL',
  super: 'SUPER',
  meta: 'SUPER',
  command: 'SUPER',
  cmd: 'SUPER'
}

const KEYS: Record<string, string> = {
  printscreen: 'Print',
  pageup: 'Prior',
  pagedown: 'Next',
  return: 'Return',
  enter: 'Return',
  space: 'space',
  tab: 'Tab',
  backspace: 'BackSpace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  escape: 'Escape',
  esc: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  plus: 'plus',
  numadd: 'KP_Add',
  // Side buttons: BTN_SIDE and BTN_EXTRA.
  mouse4: 'mouse:275',
  mouse5: 'mouse:276'
}

/** `Mouse4`/`Mouse5` (optionally with modifiers): Podium's own names, which Electron's globalShortcut doesn't know. */
export const isMouseAccelerator = (accelerator: string): boolean =>
  /^mouse[45]$/i.test(accelerator.split('+').pop() ?? '')

/** Side buttons as the browser numbers them (`MouseEvent.button`). */
export const DOM_MOUSE_BUTTONS: Record<number, string> = { 3: 'Mouse4', 4: 'Mouse5' }
/** Side buttons as the input hook (libuiohook) numbers them. */
export const HOOK_MOUSE_BUTTONS: Record<number, string> = { 4: 'Mouse4', 5: 'Mouse5' }

interface Modifiers {
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const withModifiers = (e: Modifiers, key: string): string =>
  [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key]
    .filter(Boolean)
    .join('+')

/** Accelerator for a mouse button press, or null for buttons that can't be hotkeys (left, right, middle). */
export function acceleratorFromMouse(
  e: Modifiers & { button: number },
  buttons: Record<number, string>
): string | null {
  const name = buttons[e.button]
  return name ? withModifiers(e, name) : null
}

/** Electron accelerator (`Alt+Shift+F9`) → Hyprland bind fields (`ALT SHIFT`, `F9`). */
export function acceleratorToHyprland(accelerator: string): { mods: string; key: string } | null {
  const parts = accelerator.split('+').filter(Boolean)
  const key = parts.pop()
  if (!key) return null
  const mods: string[] = []
  for (const part of parts) {
    const mod = MODS[part.toLowerCase()]
    if (!mod) return null
    if (!mods.includes(mod)) mods.push(mod)
  }
  return { mods: mods.join(' '), key: KEYS[key.toLowerCase()] ?? key }
}

/** Command-line flags that trigger an action in the running instance. */
export function actionToArgs(action: ClipAction): string[] {
  return action.kind === 'clip' ? [`--clip=${action.seconds}`] : ['--bookmark']
}

/** `--clip 30` / `--clip=30` / `--bookmark` from a second launch's argv. */
export function actionFromArgs(argv: string[]): ClipAction | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--bookmark') return { kind: 'bookmark' }
    const inline = /^--clip=(\d+)$/.exec(arg)
    const seconds = inline ? Number(inline[1]) : arg === '--clip' ? Number(argv[i + 1] ?? 30) : NaN
    if (arg === '--clip' || inline)
      return { kind: 'clip', seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 30 }
  }
  return null
}

/** Accelerator from a keydown event, or null while only modifiers are held. */
export function acceleratorFromKey(e: Modifiers & { key: string; code: string }): string | null {
  if (['Alt', 'Control', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return null
  let key: string
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key
  else if (/^Numpad\d$/.test(e.code)) key = `num${e.code.slice(6)}`
  else {
    const named: Record<string, string> = {
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Enter: 'Return',
      Escape: 'Escape',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      PrintScreen: 'PrintScreen',
      Pause: 'Pause'
    }
    const name = named[e.key]
    if (!name) return null
    key = name
  }
  return withModifiers(e, key)
}

/** Same key combination, however it's spelled: `Ctrl+Alt+X` and `Alt+Control+x` give the same result. */
export function acceleratorKey(accelerator: string): string {
  const parts = accelerator.split('+').filter(Boolean)
  const key = (parts.pop() ?? '').toLowerCase()
  const mods = [...new Set(parts.map((p) => MODS[p.toLowerCase()] ?? p.toUpperCase()))].sort()
  return [...mods, key].join('+')
}

export interface ShortcutPlan {
  /** Registered accelerators no hotkey uses any more. */
  unregister: string[]
  /** Accelerators to register now (already registered ones stay as they are). */
  register: string[]
  /** Hotkeys whose key another hotkey already has; the first one listed keeps it. */
  duplicates: string[]
}

/**
 * What to change so exactly the wanted hotkeys are registered. Keys that stay are left alone: on Windows,
 * releasing a key and taking it straight back can fail as if another app had it.
 */
export function planShortcuts(registered: Iterable<string>, hotkeys: Hotkey[]): ShortcutPlan {
  const wanted = new Map<string, string>()
  const duplicates: string[] = []
  for (const hotkey of hotkeys) {
    if (!hotkey.accelerator) continue
    const key = acceleratorKey(hotkey.accelerator)
    if (wanted.has(key)) duplicates.push(hotkey.id)
    else wanted.set(key, hotkey.accelerator)
  }
  const current = new Map([...registered].map((a) => [acceleratorKey(a), a]))
  return {
    unregister: [...current].filter(([key]) => !wanted.has(key)).map(([, a]) => a),
    register: [...wanted].filter(([key]) => !current.has(key)).map(([, a]) => a),
    duplicates
  }
}

/** One line written to Podium's command pipe by a compositor bind: `clip 30` or `bookmark`. */
export function actionToCommand(action: ClipAction): string {
  return action.kind === 'clip' ? `clip ${action.seconds}` : 'bookmark'
}

export function actionFromCommand(line: string): ClipAction | null {
  const [verb, arg] = line.trim().toLowerCase().split(/\s+/)
  if (verb === 'bookmark') return { kind: 'bookmark' }
  if (verb !== 'clip') return null
  const seconds = Number(arg)
  return { kind: 'clip', seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 30 }
}

const MODMASK: Record<string, number> = { SHIFT: 1, CTRL: 4, ALT: 8, SUPER: 64 }

/** Hyprland's modifier bitmask for `ALT SHIFT` style modifiers (as `hyprctl binds -j` reports them). */
export function hyprlandModmask(mods: string): number {
  return mods
    .split(/\s+/)
    .filter(Boolean)
    .reduce((mask, mod) => mask | (MODMASK[mod] ?? 0), 0)
}

/** Lua string literal (Hyprland's Lua config is driven with `hyprctl eval`). */
export const luaString = (s: string): string =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`

/** The key as Hyprland's Lua config writes it: `ALT + SHIFT + F9`. */
export const luaKey = (bind: { mods: string; key: string }): string =>
  [...bind.mods.split(/\s+/).filter(Boolean), bind.key].join(' + ')
