import { describe, expect, it } from 'vitest'
import {
  acceleratorFromKey,
  acceleratorToHyprland,
  actionFromArgs,
  actionFromCommand,
  actionToArgs,
  actionToCommand,
  hyprlandModmask,
  luaKey,
  luaString
} from '@core/hotkeys'

describe('hotkeys', () => {
  it('converts accelerators to Hyprland binds', () => {
    expect(acceleratorToHyprland('Alt+F9')).toEqual({ mods: 'ALT', key: 'F9' })
    expect(acceleratorToHyprland('CommandOrControl+Shift+PageUp')).toEqual({
      mods: 'CTRL SHIFT',
      key: 'Prior'
    })
    expect(acceleratorToHyprland('F10')).toEqual({ mods: '', key: 'F10' })
    expect(acceleratorToHyprland('Hyper+X')).toBeNull()
  })

  it('round-trips actions through command-line flags', () => {
    expect(actionFromArgs(['podium', ...actionToArgs({ kind: 'clip', seconds: 45 })])).toEqual({
      kind: 'clip',
      seconds: 45
    })
    expect(actionFromArgs(['podium', '--clip=90'])).toEqual({ kind: 'clip', seconds: 90 })
    expect(actionFromArgs(['podium', '--clip'])).toEqual({ kind: 'clip', seconds: 30 })
    expect(actionFromArgs(['podium', '--bookmark'])).toEqual({ kind: 'bookmark' })
    expect(actionFromArgs(['podium', '--hidden'])).toBeNull()
  })

  it('records accelerators from key events', () => {
    const e = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }
    expect(acceleratorFromKey({ ...e, key: 'F9', code: 'F9', altKey: true })).toBe('Alt+F9')
    expect(acceleratorFromKey({ ...e, key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })).toBe(
      'Control+Shift+K'
    )
    expect(acceleratorFromKey({ ...e, key: 'Alt', code: 'AltLeft', altKey: true })).toBeNull()
    expect(acceleratorFromKey({ ...e, key: '§', code: 'Backquote' })).toBeNull()
  })
})

describe('compositor commands', () => {
  it('round-trips actions through pipe commands', () => {
    expect(actionFromCommand(actionToCommand({ kind: 'clip', seconds: 45 }))).toEqual({
      kind: 'clip',
      seconds: 45
    })
    expect(actionFromCommand('bookmark\n')).toEqual({ kind: 'bookmark' })
    expect(actionFromCommand('clip')).toEqual({ kind: 'clip', seconds: 30 })
    expect(actionFromCommand('rm -rf /')).toBeNull()
  })

  it('builds Hyprland modmasks and Lua binds', () => {
    expect(hyprlandModmask('ALT')).toBe(8)
    expect(hyprlandModmask('CTRL SHIFT')).toBe(5)
    expect(hyprlandModmask('')).toBe(0)
    expect(luaKey({ mods: 'ALT SHIFT', key: 'F9' })).toBe('ALT + SHIFT + F9')
    expect(luaKey({ mods: '', key: 'F9' })).toBe('F9')
    expect(luaString(`echo "a" > 'b'\\`)).toBe(`"echo \\"a\\" > 'b'\\\\"`)
  })
})
