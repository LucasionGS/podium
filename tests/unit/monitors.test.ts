import { describe, expect, it } from 'vitest'
import type { Monitor } from '@shared/ipc'
import { deskLayout, monitorName, withHyprlandLayout, type HyprMonitor } from '@core/capture/monitors'

// The dev machine: a portrait monitor on the left, a TV above and two monitors side by side below it.
const hypr: HyprMonitor[] = [
  {
    name: 'HDMI-A-1',
    make: 'XXX',
    model: 'Beyond TV',
    x: 1080,
    y: 0,
    width: 1920,
    height: 1080,
    scale: 1,
    transform: 0
  },
  {
    name: 'DP-1',
    make: 'Acer Technologies',
    model: 'Acer B246HYL',
    x: 0,
    y: 630,
    width: 1920,
    height: 1080,
    scale: 1,
    transform: 3,
    focused: true
  },
  {
    name: 'DP-2',
    make: 'ASUSTek COMPUTER INC',
    model: 'XG258',
    x: 1080,
    y: 1080,
    width: 1920,
    height: 1080,
    scale: 1,
    transform: 0
  },
  {
    name: 'DP-3',
    make: 'BNQ',
    model: 'ZOWIE XL LCD',
    x: 3000,
    y: 1080,
    width: 1920,
    height: 1080,
    scale: 1,
    transform: 0
  }
]
const gsrMonitors: Monitor[] = [
  { id: 'HDMI-A-1', width: 1920, height: 1080 },
  { id: 'DP-1', width: 1080, height: 1920 },
  { id: 'DP-2', width: 1920, height: 1080 },
  { id: 'DP-3', width: 1920, height: 1080 }
]

describe('monitorName', () => {
  it('shortens the make to its brand and avoids repeating it', () => {
    expect(monitorName('ASUSTek COMPUTER INC', 'XG258')).toBe('ASUSTek XG258')
    expect(monitorName('Acer Technologies', 'Acer B246HYL')).toBe('Acer B246HYL')
    expect(monitorName('BNQ', 'ZOWIE XL LCD')).toBe('BNQ ZOWIE XL LCD')
  })

  it('skips placeholder makes and empty EDID fields', () => {
    expect(monitorName('XXX', 'Beyond TV')).toBe('Beyond TV')
    expect(monitorName('Unknown', '')).toBeUndefined()
    expect(monitorName('', '')).toBeUndefined()
    expect(monitorName('Dell Inc.', '')).toBe('Dell Inc.')
  })
})

describe('withHyprlandLayout', () => {
  it('adds desktop bounds, swapping sides for rotated outputs, and model names', () => {
    const [tv, portrait, main] = withHyprlandLayout(gsrMonitors, hypr)
    expect(tv).toMatchObject({ label: 'Beyond TV', bounds: { x: 1080, y: 0, width: 1920, height: 1080 } })
    expect(portrait).toMatchObject({
      label: 'Acer B246HYL',
      bounds: { x: 0, y: 630, width: 1080, height: 1920 }
    })
    expect(main).toMatchObject({ id: 'DP-2', label: 'ASUSTek XG258', width: 1920, height: 1080 })
  })

  it('uses logical size for scaled outputs', () => {
    const [m] = withHyprlandLayout(
      [{ id: 'eDP-1', width: 2880, height: 1800 }],
      [{ name: 'eDP-1', x: 0, y: 0, width: 2880, height: 1800, scale: 2 }]
    )
    expect(m!.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
  })

  it('keeps monitors Hyprland does not know, and existing labels', () => {
    const monitors = withHyprlandLayout([{ id: 'DP-9', width: 1920, height: 1080, label: 'Mine' }], hypr)
    expect(monitors).toEqual([{ id: 'DP-9', width: 1920, height: 1080, label: 'Mine' }])
    expect(withHyprlandLayout(gsrMonitors, [])).toEqual(gsrMonitors)
  })
})

describe('deskLayout', () => {
  it('scales the real arrangement into a unit box', () => {
    const { aspect, tiles } = deskLayout(withHyprlandLayout(gsrMonitors, hypr))
    // 4920 × 2550: the portrait monitor reaches below the others.
    expect(aspect).toBeCloseTo(4920 / 2550)
    const tile = (id: string) => tiles.find((t) => t.id === id)!
    expect(tile('DP-1')).toMatchObject({ left: 0, top: 630 / 2550 })
    expect(tile('DP-1').height).toBeCloseTo(1920 / 2550)
    expect(tile('DP-3').left + tile('DP-3').width).toBeCloseTo(1)
    expect(tile('HDMI-A-1').top).toBe(0)
  })

  it('normalises desktops that do not start at 0,0', () => {
    const { tiles } = deskLayout([
      { id: 'A', width: 100, height: 100, bounds: { x: -100, y: -50, width: 100, height: 100 } },
      { id: 'B', width: 100, height: 100, bounds: { x: 0, y: -50, width: 100, height: 100 } }
    ])
    expect(tiles).toEqual([
      { id: 'A', left: 0, top: 0, width: 0.5, height: 1 },
      { id: 'B', left: 0.5, top: 0, width: 0.5, height: 1 }
    ])
  })

  it('lines monitors up side by side when positions are unknown', () => {
    const { aspect, tiles } = deskLayout(gsrMonitors)
    expect(aspect).toBeCloseTo((1920 * 3 + 1080) / 1920)
    expect(tiles.map((t) => t.top)).toEqual([0, 0, 0, 0])
    expect(tiles[1]!.left).toBeCloseTo(1920 / 6840)
    expect(tiles[0]!.height).toBeCloseTo(1080 / 1920)
  })

  it('handles no monitors', () => {
    expect(deskLayout([]).tiles).toEqual([])
  })
})
