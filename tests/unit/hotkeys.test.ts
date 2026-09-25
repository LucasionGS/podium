import { describe, expect, it } from 'vitest'
import type { Hotkey } from '@shared/ipc'
import {
  acceleratorFromKey,
  acceleratorFromMouse,
  acceleratorKey,
  DOM_MOUSE_BUTTONS,
  HOOK_MOUSE_BUTTONS,
  isMouseAccelerator,
  planShortcuts,
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
    expect(acceleratorToHyprland('Mouse4')).toEqual({ mods: '', key: 'mouse:275' })
    expect(acceleratorToHyprland('Alt+Mouse5')).toEqual({ mods: 'ALT', key: 'mouse:276' })
  })

  it('records side mouse buttons from browser and hook events', () => {
    const e = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }
    expect(acceleratorFromMouse({ ...e, button: 3 }, DOM_MOUSE_BUTTONS)).toBe('Mouse4')
    expect(acceleratorFromMouse({ ...e, button: 4, altKey: true }, DOM_MOUSE_BUTTONS)).toBe('Alt+Mouse5')
    expect(acceleratorFromMouse({ ...e, button: 4 }, HOOK_MOUSE_BUTTONS)).toBe('Mouse4')
    expect(acceleratorFromMouse({ ...e, button: 5, ctrlKey: true }, HOOK_MOUSE_BUTTONS)).toBe(
      'Control+Mouse5'
    )
    // Left, right and middle clicks stay clicks.
    for (const button of [0, 1, 2])
      expect(acceleratorFromMouse({ ...e, button }, DOM_MOUSE_BUTTONS)).toBeNull()
    expect(acceleratorFromMouse({ ...e, button: 3 }, HOOK_MOUSE_BUTTONS)).toBeNull()
  })

  it('tells mouse buttons from keys', () => {
    expect(isMouseAccelerator('Mouse4')).toBe(true)
    expect(isMouseAccelerator('Alt+mouse5')).toBe(true)
    expect(isMouseAccelerator('Alt+F9')).toBe(false)
    expect(isMouseAccelerator('Mouse1')).toBe(false)
    expect(acceleratorKey('Alt+Mouse4')).toBe(acceleratorKey('alt+mouse4'))
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

describe('global shortcuts', () => {
  const hotkey = (id: string, accelerator: string | null): Hotkey => ({
    id,
    accelerator,
    action: { kind: 'clip', seconds: 30 }
  })

  it('compares accelerators however they are spelled', () => {
    expect(acceleratorKey('Ctrl+Alt+X')).toBe(acceleratorKey('Alt+Control+x'))
    expect(acceleratorKey('CommandOrControl+F9')).toBe(acceleratorKey('Control+F9'))
    expect(acceleratorKey('Alt+F9')).not.toBe(acceleratorKey('Alt+Shift+F9'))
  })

  it('only touches the keys that changed', () => {
    const plan = planShortcuts(
      ['Alt+F9', 'Alt+F10', 'Alt+F8'],
      [hotkey('a', 'Alt+F9'), hotkey('b', 'Control+Shift+K'), hotkey('c', 'Alt+F8')]
    )
    expect(plan).toEqual({ unregister: ['Alt+F10'], register: ['Control+Shift+K'], duplicates: [] })
  })

  it('registers everything from scratch and releases everything when suspended', () => {
    const hotkeys = [hotkey('a', 'Alt+F9'), hotkey('b', null)]
    expect(planShortcuts([], hotkeys)).toEqual({ unregister: [], register: ['Alt+F9'], duplicates: [] })
    expect(planShortcuts(['Alt+F9'], [])).toEqual({ unregister: ['Alt+F9'], register: [], duplicates: [] })
  })

  it('reports a key two hotkeys share instead of registering it twice', () => {
    const plan = planShortcuts(['Alt+F9'], [hotkey('a', 'Alt+F9'), hotkey('b', 'alt+f9')])
    expect(plan).toEqual({ unregister: [], register: [], duplicates: ['b'] })
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
