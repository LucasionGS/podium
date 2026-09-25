import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { normalizeSettings } from '@core/settings'

describe('normalizeSettings', () => {
  it('fills in everything for an empty or broken file', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
  })

  it('survives a settings file from an older prototype with a different shape', () => {
    const legacy = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/legacy-settings.json'), 'utf8')
    )
    const settings = normalizeSettings(legacy)
    // `hotkeys` was an object there; it must come back as a list.
    expect(settings.hotkeys).toEqual(DEFAULT_SETTINGS.hotkeys)
    expect(settings.capture.bufferSeconds).toBe(120)
    expect(settings.capture.fps).toBe(60)
    expect(settings.audio).toEqual(DEFAULT_SETTINGS.audio)
  })

  it('keeps valid values and clamps or drops invalid ones', () => {
    const settings = normalizeSettings({
      capture: { fps: 144, codec: 'vp9', bufferSeconds: 99999, storage: 'disk' },
      audio: { desktop: 'device:x.monitor', mic: null },
      hotkeys: [{ id: 'a', accelerator: 'Alt+F1', action: { kind: 'clip', seconds: 15 } }, { id: 'broken' }],
      gameRules: [{ match: 'blender', name: null }, 42]
    })
    expect(settings.capture).toMatchObject({ fps: 144, codec: 'h264', bufferSeconds: 1800, storage: 'disk' })
    expect(settings.audio).toEqual({ desktop: 'device:x.monitor', mic: null })
    expect(settings.hotkeys).toEqual([
      { id: 'a', accelerator: 'Alt+F1', action: { kind: 'clip', seconds: 15 } }
    ])
    expect(settings.gameRules).toEqual([{ match: 'blender', name: null }])
  })
})
