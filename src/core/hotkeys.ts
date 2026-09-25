import type { ClipAction } from '@shared/ipc'

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
  numadd: 'KP_Add'
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
export function acceleratorFromKey(e: {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
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
  const mods = [
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super'
  ].filter(Boolean)
  return [...mods, key].join('+')
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
